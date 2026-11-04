import { escapeHtml as esc } from './ui'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const sqlite = require('../sqlite-compat.js')
const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 150*1024*1024, files: 1, fields: 6, fieldSize: 10000 } }).single('document')
const base = '/plugins/signalk-quartermaster'
export const librarySchema = `
CREATE TABLE IF NOT EXISTS library_documents (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, document_type TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS library_asset_links (
 document_id INTEGER NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
 asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 PRIMARY KEY(document_id, asset_id));`
export function registerLibrary(router: any, getConfig: () => { dataDir: string, databaseFile: string }) {
 const open = async () => {
  const c = getConfig()
  const db: any = await new Promise((resolve,reject) => { const d = new sqlite.Database(path.join(c.dataDir,c.databaseFile), sqlite.OPEN_READWRITE, (e: any) => e ? reject(e) : resolve(d)) })
  const exec = (sql: string) => new Promise<void>((resolve,reject)=>db.exec(sql,(e:any)=>e?reject(e):resolve()))
  try { await exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'+librarySchema) } catch(e) { db.close(); throw e }
  return { db, exec, all: (sql: string, params: any[] = []): Promise<any[]> => new Promise((resolve,reject)=>db.all(sql,params,(e:any,r:any[])=>e?reject(e):resolve(r))),
   run: (sql:string,params:any[]=[]):Promise<any> => new Promise((resolve,reject)=>db.run(sql,params,function(this:any,e:any){e?reject(e):resolve({id:this.lastID,changes:this.changes})})) }
 }
 const handler = (fn:any) => async(req:any,res:any) => { let c:any; try { c=await open(); await fn(req,res,c) } catch(e:any) { console.error('Quartermaster Library:',e); if(!res.headersSent)res.status(e.status||500).send(e.status ? e.message : 'Library operation failed. Check the Signal K log.') } finally { if(c)c.db.close() } }
 const bad = (message:string):never => { throw Object.assign(new Error(message),{status:400}) }
 const text = (v:any,max:number) => typeof v==='string' && v.length<=max ? v.trim() : bad('Invalid or oversized field.')
 const id = (v:any) => /^\d+$/.test(String(v)) && Number(v)>0 ? Number(v) : bad('Invalid document ID.')
 const links = async(c:any,value:any) => {
  const raw = Array.isArray(value)?value:value?[value]:[]
  const ids = [...new Set(raw.map(id))]
  if(ids.length>500)bad('Too many equipment links.')
  for(const n of ids)if(!(await c.all('SELECT id FROM assets WHERE id=?',[n])).length)bad('Equipment no longer exists. Refresh the page.')
  return ids
 }
 const saveLinks = async(c:any,n:number,ids:number[]) => {
  await c.run('DELETE FROM library_asset_links WHERE document_id=?',[n])
  for(const a of ids)await c.run('INSERT INTO library_asset_links(document_id,asset_id) VALUES(?,?)',[n,a])
 }
 const parse = (req:any,res:any,next:any) => upload(req,res,(e:any)=>e?res.status(400).send('Upload failed: PDF only, maximum 150 MB.'):next())
 router.access('readonly').get('/library',handler(async(req:any,res:any,c:any)=>{
  const q = typeof req.query.q==='string'?req.query.q.slice(0,200):''
  const asset = typeof req.query.asset==='string'?req.query.asset:''
  const docs = await c.all(`SELECT d.* FROM library_documents d WHERE
   (d.title LIKE ? OR d.description LIKE ? OR d.document_type LIKE ? OR d.file_name LIKE ?)
   AND (?='' OR EXISTS(SELECT 1 FROM library_asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.document_id=d.id AND a.qr_code=?)) ORDER BY d.title,d.id`,[...Array(4).fill('%'+q+'%'),asset,asset])
  if (asset && req.query.format === 'json') {
   return res.json({ documents: docs.map(({ id, title, file_name, description }: {
    id: number
    title: string
    file_name: string
    description: string
   }) =>
    ({ id, title, file_name, description, library: true })) })
  }
  const assets = await c.all('SELECT id,name,qr_code FROM assets ORDER BY name')
  const pairs = await c.all('SELECT document_id,asset_id FROM library_asset_links')
  const choices=(selected:number[])=>assets.map((a:any)=>`<label class="choice"><input type="checkbox" name="assets" value="${a.id}" ${selected.includes(a.id)?'checked':''}> ${esc(a.name)} (${esc(a.qr_code)})</label>`).join('') || '<p>No equipment yet. Documents can be saved without links.</p>'
  const fields=(d:any)=>`<label>Title<input name="title" required maxlength="200" value="${esc(d.title)}"></label><label>Type<input name="document_type" maxlength="100" placeholder="Manual, specification, receipt…" value="${esc(d.document_type)}"></label><label>Description<textarea name="description" maxlength="3000">${esc(d.description)}</textarea></label>`
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library | Quartermaster</title><style>body{font:17px Arial;background:#f2f5f7;color:#183044;margin:0}header{background:#17324d;color:white;padding:24px}main{max-width:960px;margin:auto;padding:20px}section,article{background:white;padding:20px;margin:16px 0;border:1px solid #ccd8df;border-radius:10px}input:not([type=checkbox]),textarea{display:block;box-sizing:border-box;width:100%;padding:10px;margin:6px 0 14px;font:inherit}button,.button{display:inline-block;background:#17324d;color:white;padding:12px;border:0;border-radius:6px;font:inherit;margin:6px 0}a{color:#075f8a}.choice{display:block;padding:8px}summary{cursor:pointer;padding:12px 0}fieldset{margin:14px 0;max-height:280px;overflow:auto}label{display:block}small{overflow-wrap:anywhere}</style><header><h1>Document Library</h1><p>Manuals, specifications, and boat records in one place.</p></header><main><a href="${base}/home">← Quartermaster home</a>
  <section><form method="get"><label>Search titles, types, descriptions, and filenames<input name="q" value="${esc(q)}" type="search"></label>${asset?`<input type="hidden" name="asset" value="${esc(asset)}"><p>Showing documents linked to ${esc(asset)}. <a href="${base}/library">Show all documents</a></p>`:''}<button>Search</button></form></section>
  <section><details><summary>Upload a PDF</summary><form action="${base}/library/upload" method="post" enctype="multipart/form-data">${fields({})}<label>PDF (maximum 150 MB)<input type="file" name="document" accept="application/pdf,.pdf" required></label><fieldset><legend>Link to equipment (optional)</legend>${choices([])}</fieldset><button>Save document</button></form></details></section><h2>Documents (${docs.length})</h2>
  ${docs.map((d:any)=>{const selected=pairs.filter((p:any)=>p.document_id===d.id).map((p:any)=>p.asset_id);return `<article><h2>${esc(d.title)}</h2><p>${esc(d.document_type)}</p><p>${esc(d.description)}</p><small>${esc(d.file_name)} · ${esc(d.created_at)}</small><p><a class="button" target="_blank" rel="noopener" href="${base}/library/${d.id}/file">Open PDF</a></p><p>Equipment: ${assets.filter((a:any)=>selected.includes(a.id)).map((a:any)=>`<a href="${base}/asset/${encodeURIComponent(a.qr_code)}">${esc(a.name)}</a>`).join(', ')||'No links'}</p><details><summary>Edit details and equipment links</summary><form method="post" enctype="multipart/form-data" action="${base}/library/${d.id}/edit">${fields(d)}<fieldset><legend>Linked equipment</legend>${choices(selected)}</fieldset><button>Save changes</button></form></details><details><summary>Delete document</summary><p>Removes this Library document and its equipment links.</p><form method="post" enctype="multipart/form-data" action="${base}/library/${d.id}/delete"><label><input type="checkbox" name="confirm" value="yes" required> Confirm deletion</label><button>Delete document</button></form></details></article>`}).join('')||'<p>No matching documents. Upload a PDF to begin.</p>'}<p>Sign in to Signal K with edit access to upload or change documents. Existing equipment attachments remain on their equipment records. Search covers document details, not text inside PDFs.</p></main></html>`)
 }))
 router.access('readwrite').post('/library/upload',parse,handler(async(req:any,res:any,c:any)=>{
  const title=text(req.body.title,200); if(!title)bad('Title is required.')
  const type=text(req.body.document_type||'',100), description=text(req.body.description||'',3000)
  const ids=await links(c,req.body.assets), f=req.file
  if(!f || !/\.pdf$/i.test(f.originalname) || f.buffer.subarray(0,5).toString()!=='%PDF-')bad('Choose a valid PDF file.')
  const dir=path.join(getConfig().dataDir,'storage','library'); await fs.mkdir(dir,{recursive:true})
  const stored=crypto.randomUUID()+'.pdf', dest=path.join(dir,stored)
  await fs.writeFile(dest,f.buffer,{flag:'wx'})
  try { await c.exec('BEGIN IMMEDIATE'); const result=await c.run('INSERT INTO library_documents(title,document_type,description,file_name,stored_name) VALUES(?,?,?,?,?)',[title,type,description,path.basename(f.originalname),stored]); await saveLinks(c,result.id,ids); await c.exec('COMMIT') }
  catch(e){await c.exec('ROLLBACK').catch(()=>{});await fs.unlink(dest).catch(()=>{});throw e}
  res.redirect(303,base+'/library')
 }))
 router.access('readwrite').post('/library/:id/edit',parse,handler(async(req:any,res:any,c:any)=>{
  const n=id(req.params.id),title=text(req.body.title,200);if(!title)bad('Title is required.')
  const type=text(req.body.document_type||'',100),description=text(req.body.description||'',3000),ids=await links(c,req.body.assets)
  if(!(await c.all('SELECT id FROM library_documents WHERE id=?',[n])).length)return res.status(404).send('Document not found.')
  try{await c.exec('BEGIN IMMEDIATE');await c.run('UPDATE library_documents SET title=?,document_type=?,description=? WHERE id=?',[title,type,description,n]);await saveLinks(c,n,ids);await c.exec('COMMIT')}catch(e){await c.exec('ROLLBACK').catch(()=>{});throw e}
  res.redirect(303,base+'/library')
 }))
 router.access('readwrite').post('/library/:id/delete',parse,handler(async(req:any,res:any,c:any)=>{
  if(req.body.confirm!=='yes')bad('Confirm deletion first.')
  const n=id(req.params.id),rows=await c.all('SELECT stored_name FROM library_documents WHERE id=?',[n])
  await c.run('DELETE FROM library_documents WHERE id=?',[n])
  if(rows.length)await fs.unlink(path.join(getConfig().dataDir,'storage','library',path.basename(rows[0].stored_name))).catch((e:any)=>{if(e.code!=='ENOENT')console.error(e)})
  res.redirect(303,base+'/library')
 }))
 router.access('readonly').get('/library/:id/file',handler(async(req:any,res:any,c:any)=>{
  const rows=await c.all('SELECT * FROM library_documents WHERE id=?',[id(req.params.id)])
  if(!rows.length)return res.status(404).send('Document not found.')
  const file=path.join(getConfig().dataDir,'storage','library',path.basename(rows[0].stored_name))
  try{await fs.access(file)}catch{return res.status(404).send('PDF file is missing.')}
  res.setHeader('Content-Type','application/pdf');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition','inline; filename="document.pdf"');res.sendFile(file)
 }))
}
