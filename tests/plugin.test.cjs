const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const sqlite=require('../sqlite-compat.js');
const factory=require('../dist/index.js');
const sourceSchema=fs.readFileSync(path.join(__dirname,'original-schema.sql'),'utf8');
function fixture(t, existing=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qm-release-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 if(existing){const db=new DatabaseSync(path.join(dir,'quartermaster.db'));db.exec(sourceSchema.replace('CREATE TABLE sqlite_sequence(name,seq);',''));
 db.exec("INSERT INTO vessels(signalk_uuid,name) VALUES('urn:test:boat','Before');INSERT INTO assets(vessel_id,asset_uuid,name,qr_code) VALUES(1,'asset-1','Preserved pump','QM-ASSET-0001')");db.close()}
 const handlers=new Map();let middleware;const errors=[];
 const app={getSelfPath:k=>({uuid:'urn:test:boat',name:'Test vessel',mmsi:'123456789'})[k],getDataDirPath:()=>dir,debug:()=>{},error:m=>errors.push(m),setPluginStatus:()=>{}};
 const plugin=factory(app);const router={use:fn=>{middleware=fn},access:()=>Object.fromEntries(['get','post','put','delete','patch'].map(verb=>[verb,(url,fn)=>handlers.set(verb+url,fn)]))};
 plugin.registerWithRouter(router);
 async function start(settings={}){plugin.start(settings);await new Promise((resolve,reject)=>middleware({}, {status:()=>({json:()=>reject(Error('initialization failed'))})},resolve));}
 return {dir,plugin,handlers,start,errors};
}
test('fresh install creates schema, empty equipment registry and current Signal K vessel',async t=>{
 const f=fixture(t);await f.start();const db=new DatabaseSync(path.join(f.dir,'quartermaster.db'));
 assert.equal(db.prepare('SELECT count(*) n FROM assets').get().n,0);assert.equal(db.prepare('SELECT name FROM vessels').get().name,'Test vessel');
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,10);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 assert.ok(fs.existsSync(path.join(f.dir,'storage/intake')));
 const output=await new Promise(resolve=>f.handlers.get('get/home')({}, {status(){return this},send:resolve}));
 assert.match(output,/Test vessel/);assert.match(output,/AI access and remaining trial lookups/);
});
test('existing schema/data preserved and repeat startup is safe',async t=>{
 const f=fixture(t,true);await f.start();await f.start();const db=new DatabaseSync(path.join(f.dir,'quartermaster.db'));
 assert.equal(db.prepare('SELECT name FROM assets').get().name,'Preserved pump');assert.equal(db.prepare('SELECT count(*) n FROM vessels').get().n,1);
 assert.equal(db.prepare('SELECT name FROM vessels').get().name,'Test vessel');db.close();
});
test('database filename traversal refused',async t=>{const f=fixture(t);await assert.rejects(f.start({databaseFile:'../outside.db'}));});
test('callback adapter supports transactions, bindings, lastID and changes',async t=>{
 const f=fixture(t);const db=await new Promise((resolve,reject)=>{const d=new sqlite.Database(path.join(f.dir,'adapter.db'),e=>e?reject(e):resolve(d))});
 const run=(sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this)}));
 await run('CREATE TABLE things(id INTEGER PRIMARY KEY,name TEXT)');await run('BEGIN IMMEDIATE');
 const row=await run('INSERT INTO things(name) VALUES (?)',['pump']);assert.equal(row.lastID,1);assert.equal(row.changes,1);await run('ROLLBACK');
 const rows=await new Promise((resolve,reject)=>db.all('SELECT * FROM things',[],(e,r)=>e?reject(e):resolve(r)));assert.deepEqual(rows,[]);
 await new Promise(resolve=>db.close(resolve));
});
test('trial result saved locally and same intake retry uses stable request ID',async t=>{
 const f=fixture(t);await f.start();const db=new DatabaseSync(path.join(f.dir,'quartermaster.db'));
 db.exec("INSERT INTO asset_intakes(vessel_id,intake_code,status) VALUES(1,'INTAKE-000001','pending')");db.close();
 const dir=path.join(f.dir,'storage/intake/INTAKE-000001');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'equipment.jpg'),Buffer.from([255,216,255,0]));
 const prior=global.fetch,token=process.env.QUARTERMASTER_TRIAL_TOKEN,ids=[];process.env.QUARTERMASTER_TRIAL_TOKEN='test-token';
 const result={equipment_name:'Trial pump',category:null,manufacturer:null,model:null,serial_number:null,part_number:null,location_suggestion:null,visible_specifications:null,plate_text:null,confidence:75,uncertainty_notes:[]};
 global.fetch=async(url,options)=>{assert.equal(new URL(url).protocol,'https:');assert.equal(options.redirect,'error');ids.push(JSON.parse(options.body).requestId);return {ok:true,json:async()=>({limit:5,remaining:4,result,model:'test-model'})}};
 t.after(()=>{global.fetch=prior;if(token===undefined)delete process.env.QUARTERMASTER_TRIAL_TOKEN;else process.env.QUARTERMASTER_TRIAL_TOKEN=token});
 const {analyzeIntake}=require('../dist/intake-analysis.js');const opts={dataDir:f.dir,intakeCode:'INTAKE-000001',aiMode:'trial',trialServiceUrl:'https://trial.example.test'};
 await analyzeIntake(opts);await analyzeIntake(opts);assert.equal(ids[0],ids[1]);
 const check=new DatabaseSync(path.join(f.dir,'quartermaster.db'));assert.equal(check.prepare('SELECT status FROM asset_intakes').get().status,'ai_complete');check.close();
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ai-result.json'),'utf8')).equipment_name,'Trial pump');
});
test('trial client refuses plaintext URLs',async()=>{
 const {trialRequest}=require('../dist/trial-client.js');await assert.rejects(trialRequest('http://example.test','GET','/v1/status'),/HTTPS/);
});
test('printer uses supplied database, queue and QR address; unsafe address refused',async t=>{
 const f=fixture(t,true);await f.start();
 const fakeLp=path.join(f.dir,'lp'),output=path.join(f.dir,'printed.json');
 fs.writeFileSync(fakeLp,'#!/usr/bin/env node\nlet data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>require("fs").writeFileSync(process.env.QM_PRINT_CAPTURE,JSON.stringify({args:process.argv.slice(2),data})));\n',{mode:0o700});
 const {spawnSync}=require('node:child_process');
 const args=[path.join(__dirname,'../print-asset-label.js'),'1',path.join(f.dir,'quartermaster.db'),'TestQueue','http://boat.test:3000'];
 const run=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,PATH:f.dir+path.delimiter+process.env.PATH,QM_PRINT_CAPTURE:output}});
 assert.equal(run.status,0,run.stderr);const printed=JSON.parse(fs.readFileSync(output,'utf8'));
 assert.deepEqual(printed.args,['-d','TestQueue','-o','raw']);assert.match(printed.data,/http:\/\/boat\.test:3000\/plugins\/signalk-quartermaster\/asset\/QM-ASSET-0001/);
 assert.match(printed.data,/Preserved pump/);
 args[4]='http://boat.test/^XA';const bad=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(bad.status,1);
});
