

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { analyzeIntake } from './intake-analysis'
import { trialRequest } from './trial-client'
import { renderHome, renderManualForm, type HomeAsset } from './ui'

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const multer = require('multer')
const sharp = require('sharp')
const sqlite3 = require('../sqlite-compat.js').verbose()
const activeAnalyses = new Set<string>()
const intakePhotoUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 3,
    fileSize: 12 * 1024 * 1024,
    fields: 4
  }
}).fields([
  {
    name: 'equipment',
    maxCount: 1
  },
  {
    name: 'nameplate',
    maxCount: 1
  },
  {
    name: 'location',
    maxCount: 1
  }
])
const documentUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 1,
    fileSize: 25 * 1024 * 1024,
    fields: 3
  },

  fileFilter: (
    _req: any,
    file: any,
    callback: any
  ) => {
    const hasPdfExtension =
      /\.pdf$/i.test(file.originalname)

    const hasPdfMimeType =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/x-pdf'

    if (!hasPdfExtension || !hasPdfMimeType) {
      callback(
        new Error('Only PDF documents are permitted.')
      )
      return
    }

    callback(null, true)
  }
}).single('document')
const manualAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 8, fieldSize: 2000, files: 0 }
}).none()

interface QuartermasterSettings {
  databaseFile?: string
  vesselLabel?: string
  aiMode?: 'direct' | 'trial'
  trialServiceUrl?: string
  printerName?: string
  labelBaseUrl?: string
}

module.exports = (app: ServerAPI): Plugin => {
  let dataDir = ''
  let currentSettings: QuartermasterSettings = {}
  let ready: Promise<void> = Promise.resolve()
  let databaseReady = false


  const getVesselDetails = (): Record<string, string> => {
    const read = (key: string): any => {
      const item: any = app.getSelfPath(key)
      return item && typeof item === 'object' && 'value' in item
        ? item.value : item
    }
    const text = (value: any): string =>
      value === null || value === undefined ? '' : String(value)
    const dimension = (value: any): string => {
      if (value === null || value === undefined || value === '') return ''
      const metres = Number(value)
      return Number.isFinite(metres) && metres >= 0
        ? `${metres.toFixed(2)} m / ${(metres / 0.3048).toFixed(1)} ft`
        : ''
    }
    const draft = read('design.draft')
    const length = read('design.length')
    const shipType = read('design.aisShipType')
    const shipTypeText = shipType && typeof shipType === 'object'
      ? [shipType.name, shipType.id].filter(
          (value: any) => value !== undefined && value !== null && value !== ''
        ).map(text).join(' / ')
      : text(shipType)

    return {
      'Name': text(read('name')),
      'MMSI': text(read('mmsi')),
      'Call sign': text(read('communication.callsignVhf')),
      'UUID': text(read('uuid') ?? (app as any).selfId),
      'Ship type': shipTypeText,
      'Draft (current or maximum)': dimension(draft?.current ?? draft?.maximum),
      'Length overall': dimension(length?.overall),
      'Beam': dimension(read('design.beam')),
      'Height above water': dimension(read('design.airHeight'))
    }
  }

  const plugin: Plugin = {
    id: 'signalk-quartermaster',
    name: 'Quartermaster Aboard',
    description: 'Onboard vessel asset registry and Signal K integration.',

    schema: () => ({
      type: 'object',
      properties: {
        vesselLabel: {
          type: 'string',
          title: 'Vessel label',
          description: 'Friendly vessel name used by Quartermaster.',
          default: ''
        },
        aiMode: {
          type: 'string', title: 'AI access', enum: ['direct', 'trial'],
          default: 'direct', description: 'Direct uses your OPENAI_API_KEY. Trial uses a private activation token.'
        },
        trialServiceUrl: {
          type: 'string', title: 'Trial service HTTPS URL', default: '',
          description: 'Provided by OpenOceanOS. Set QUARTERMASTER_TRIAL_TOKEN in the Signal K service environment.'
        },
        printerName: { type: 'string', title: 'CUPS label printer queue', default: 'Quartermaster_Label_Printer' },
        labelBaseUrl: {
          type: 'string', title: 'Address printed in QR labels', default: '',
          description: 'Stable address reachable by phones, for example http://your-pi.local:3000. Required for printing.'
        },
        databaseFile: {
          type: 'string',
          title: 'Database filename',
          description: 'SQLite database used by Quartermaster.',
          default: 'quartermaster.db'
        }
      }
    }),

    start: (settings) => {
      currentSettings = settings as QuartermasterSettings
      dataDir = app.getDataDirPath()
      databaseReady = false
      ready = new Promise<void>((resolve, reject) => {
        const databaseFile = currentSettings.databaseFile || 'quartermaster.db'
        if (path.basename(databaseFile) !== databaseFile || !databaseFile.endsWith('.db')) {
          reject(new Error('Database filename must be a simple .db filename'))
          return
        }
        try {
          fs.mkdirSync(dataDir, { recursive: true })
          for (const directory of ['intake', 'assets', 'documents', 'backups']) {
            fs.mkdirSync(path.join(dataDir, 'storage', directory), { recursive: true })
          }
          const schema = fs.readFileSync(path.join(__dirname, '..', 'database-schema.sql'), 'utf8')
          const db = new sqlite3.Database(path.join(dataDir, databaseFile), (openErr: Error | null) => {
            if (openErr) { reject(openErr); return }
            db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; ' + schema,
              (schemaErr: Error | null) => {
                if (schemaErr) {
                  db.exec('ROLLBACK', () => db.close())
                  reject(schemaErr)
                  return
                }
                const details = getVesselDetails()
                if (!details.UUID) {
                  db.exec('ROLLBACK', () => db.close())
                  reject(new Error('Configure the vessel UUID in Signal K before enabling Quartermaster'))
                  return
                }
                // Refresh this server's vessel only. Never copy a distributor's vessel identity.
                db.run(`INSERT INTO vessels (signalk_uuid, name, mmsi, configured_label)
                  VALUES (?, ?, ?, ?) ON CONFLICT(signalk_uuid) DO UPDATE SET
                  name=excluded.name, mmsi=excluded.mmsi,
                  configured_label=excluded.configured_label, updated_at=CURRENT_TIMESTAMP`,
                  [details.UUID, details.Name || currentSettings.vesselLabel || 'Unnamed vessel',
                    details.MMSI || null, currentSettings.vesselLabel || null],
                  (vesselErr: Error | null) => {
                    if (vesselErr) {
                      db.exec('ROLLBACK', () => db.close())
                      reject(vesselErr)
                      return
                    }
                    db.exec('COMMIT', (commitErr: Error | null) => {
                      db.close()
                      if (commitErr) { reject(commitErr); return }
                      databaseReady = true
                      app.setPluginStatus('Quartermaster Aboard is running')
                      resolve()
                    })
                  })
              })
          })
        } catch (error) { reject(error) }
      })
      // Attach a rejection handler immediately; requests also wait for initialization.
      ready.catch(() => {
        app.error('Quartermaster database initialization failed. Check database compatibility and vessel configuration.')
        app.setPluginStatus('Quartermaster database initialization failed')
      })
    },

    stop: () => {
      app.debug('Quartermaster Aboard stopped')
    },

    registerWithRouter: (router) => {
      ;(router as any).use((_req: any, res: any, next: any) => {
        ready.then(() => next()).catch(() => res.status(503).json({
          ok: false, error: 'Quartermaster database is not ready. Check the server log and vessel configuration.'
        }))
      })
      router.access('readonly').get('/ai/status', async (_req: any, res: any) => {
        if (currentSettings.aiMode !== 'trial') {
          res.json({ ok: true, mode: 'direct', message: 'Uses the owner-provided OpenAI key; no included trial allowance.' })
          return
        }
        try {
          const status = await trialRequest(currentSettings.trialServiceUrl || '', 'GET', '/v1/status')
          res.json({ ok: true, mode: 'trial', ...status })
        } catch (error) {
          res.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'Trial service unavailable' })
        }
      })
      router.access('readonly').get('/ai', (_req: any, res: any) => {
        res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1"><title>Quartermaster AI access</title>
          <body style="font:20px system-ui;max-width:700px;margin:40px auto;padding:20px">
          <h1>AI equipment identification</h1><p id="status">Checking access…</p>
          <p>Each successful new trial identification uses one of five included lookups. Failed requests do not use a lookup.
          Equipment records, manual entry, photographs and documents remain available when the trial is used up.</p>
          <p>Trial analysis sends your equipment photographs to the OpenOceanOS trial service and OpenAI.
          Review photographs for personal information before submitting. Results require your review.</p>
          <a href="/plugins/signalk-quartermaster/home">Return to Quartermaster</a>
          <script>fetch('ai/status').then(r=>r.json()).then(s=>{
          document.getElementById('status').textContent=s.ok?(s.mode==='trial'?
          s.remaining+' of '+s.limit+' AI identifications remaining'+(s.pending?' ('+s.pending+' in progress)':''):s.message):s.error
          }).catch(()=>{document.getElementById('status').textContent='Unable to check AI access.'})</script></body></html>`)
      })
      /*
       * Health check
       */
      router.access('readonly').get('/health', (_req: any, res: any) => {
        res.status(200).json({
          ok: databaseReady,
          plugin: plugin.id,
          version: '1.0.0-rc.1',
          dataDir
        })
      })

      /*
       * Signal K vessel identity
       */
      router.access('readonly').get('/vessel', (_req: any, res: any) => {
        res.status(200).json({
          name: app.getSelfPath('name') ?? null,
          uuid: (app.getSelfPath('uuid') ?? (app as any).selfId) ?? null,
          mmsi: app.getSelfPath('mmsi') ?? null,
          configuredLabel: currentSettings.vesselLabel ?? ''
        })
       })

      // Home is separate from the plugin's reserved root route so that
      // Signal K can grant ordinary read-only users access to it.
      router.access('readonly').get('/home', (_req: any, res: any) => {
        const details = getVesselDetails()
        const renderVesselHome = (
          _storedName: string, assets: HomeAsset[], error = ''
        ) => renderHome(details.Name, assets, error, details).replace('</body>',
          '<p style="padding:16px;text-align:center"><a href="/plugins/signalk-quartermaster/ai">AI access and remaining trial lookups</a></p></body>')
        const dbPath = path.join(
          dataDir,
          currentSettings.databaseFile || 'quartermaster.db'
        )
        const db = new sqlite3.Database(
          dbPath,
          sqlite3.OPEN_READONLY,
          (openErr: Error | null) => {
            if (openErr) {
              app.error(`Home database open failed: ${openErr.message}`)
              res.status(500).send(renderVesselHome('', [], 'Unable to open the equipment database.'))
              return
            }
            db.get(
              'SELECT name FROM vessels ORDER BY id LIMIT 1',
              [],
              (vesselErr: Error | null, vessel: { name: string } | undefined) => {
                if (vesselErr) {
                  app.error(`Home vessel lookup failed: ${vesselErr.message}`)
                  res.status(500).send(renderVesselHome('', [], 'Unable to load vessel details.'))
                  db.close()
                  return
                }
                db.all(
                  `SELECT name, category, location, qr_code
                   FROM assets ORDER BY name COLLATE NOCASE, id`,
                  [],
                  (assetErr: Error | null, assets: HomeAsset[]) => {
                    if (assetErr) {
                      app.error(`Home equipment lookup failed: ${assetErr.message}`)
                      res.status(500).send(renderVesselHome(vessel?.name || '', [], 'Unable to load equipment.'))
                    } else {
                      res.status(200).send(renderVesselHome(vessel?.name || '', assets))
                    }
                    db.close()
                  }
                )
              }
            )
          }
        )
      })

      router.access('readonly').get('/equipment/start', (req: any, res: any) => {
        res.redirect(
          303,
          req.query?.method === 'manual'
            ? `/plugins/${plugin.id}/equipment/manual`
            : `/plugins/${plugin.id}/intakes/new`
        )
      })

      router.access('readonly').get('/equipment/manual', (_req: any, res: any) => {
        res.status(200).send(renderManualForm())
      })

      router.access('readwrite').post('/equipment/manual', (req: any, res: any) => {
        manualAssetUpload(req, res, (uploadErr: Error | null) => {
          if (uploadErr) {
            res.status(400).send(renderManualForm('The form could not be read. Check the fields and try again.'))
            return
          }
          const limits: Record<string, number> = {
            name: 150, category: 100, manufacturer: 150, model: 150,
            serial_number: 150, part_number: 150, location: 200,
            description: 1500
          }
          const values: Record<string, string> = {}
          for (const [key, maximum] of Object.entries(limits)) {
            const raw = req.body?.[key]
            if (raw !== undefined && (typeof raw !== 'string' || raw.length > maximum)) {
              res.status(400).send(renderManualForm('One or more fields are too long.', values))
              return
            }
            values[key] = typeof raw === 'string' ? raw.trim() : ''
          }
          if (!values.name || !values.category) {
            res.status(400).send(renderManualForm('Equipment name and category are required.', values))
            return
          }
          const dbPath = path.join(
            dataDir,
            currentSettings.databaseFile || 'quartermaster.db'
          )
          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READWRITE,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(`Manual asset database open failed: ${openErr.message}`)
                res.status(500).send(renderManualForm('Unable to open the equipment database.', values))
                return
              }
              let inTransaction = false
              const fail = (status: number, message: string, detail?: Error) => {
                if (detail) app.error(`Manual asset creation failed: ${detail.message}`)
                const finish = () => {
                  res.status(status).send(renderManualForm(message, values))
                  db.close()
                }
                if (inTransaction) {
                  inTransaction = false
                  db.run('ROLLBACK', (rollbackErr: Error | null) => {
                    if (rollbackErr) app.error(`Manual asset rollback failed: ${rollbackErr.message}`)
                    finish()
                  })
                } else {
                  finish()
                }
              }
              db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr: Error | null) => {
                if (beginErr) {
                  fail(500, 'Unable to begin saving equipment.', beginErr)
                  return
                }
                inTransaction = true
                db.get(
                  'SELECT id FROM vessels ORDER BY id LIMIT 1',
                  [],
                  (vesselErr: Error | null, vessel: { id: number } | undefined) => {
                    if (vesselErr) {
                      fail(500, 'Unable to find the vessel.', vesselErr)
                      return
                    }
                    if (!vessel) {
                      fail(409, 'Set up a vessel before adding equipment.')
                      return
                    }
                    db.get(
                      `SELECT COALESCE(MAX(CAST(SUBSTR(qr_code, 10) AS INTEGER)), 0)
                         AS max_number FROM assets
                       WHERE qr_code GLOB 'QM-ASSET-[0-9]*'`,
                      [],
                      (numberErr: Error | null, row: { max_number: number } | undefined) => {
                        if (numberErr) {
                          fail(500, 'Unable to create an equipment number.', numberErr)
                          return
                        }
                        const qrCode = `QM-ASSET-${String(Number(row?.max_number || 0) + 1).padStart(4, '0')}`
                        db.run(
                          `INSERT INTO assets (
                            vessel_id, asset_uuid, name, category, manufacturer,
                            model, serial_number, part_number, location,
                            description, status, qr_code
                          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
                          [vessel.id, `urn:uuid:${crypto.randomUUID()}`,
                            values.name, values.category, values.manufacturer || null,
                            values.model || null, values.serial_number || null,
                            values.part_number || null, values.location || null,
                            values.description || null, qrCode],
                          (insertErr: Error | null) => {
                            if (insertErr) {
                              fail(500, 'Unable to save the equipment.', insertErr)
                              return
                            }
                            db.run('COMMIT', (commitErr: Error | null) => {
                              if (commitErr) {
                                fail(500, 'Unable to complete the save.', commitErr)
                                return
                              }
                              inTransaction = false
                              db.close()
                              res.redirect(303, `/plugins/${plugin.id}/asset/${encodeURIComponent(qrCode)}`)
                            })
                          }
                        )
                      }
                    )
                  }
                )
              })
            }
          )
        })
      })
 /*
       * Quartermaster phone intake upload page
       */
      router.access('readonly').get(
        '/intakes/new',
        (_req: any, res: any) => {
          res.status(200).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">

              <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
              >

              <title>New Equipment Intake | Quartermaster</title>

              <style>
                * {
                  box-sizing: border-box;
                }

                body {
                  margin: 0;
                  background: #f4f6f8;
                  color: #1f2933;
                  font-family:
                    Arial,
                    Helvetica,
                    sans-serif;
                }

                header {
                  background: #17324d;
                  color: white;
                  padding: 20px;
                }

                header h1 {
                  margin: 0;
                  font-size: 25px;
                }

                main {
                  max-width: 760px;
                  margin: auto;
                  padding: 18px;
                }

                .back {
                  display: inline-block;
                  margin-bottom: 15px;
                  color: #0b6395;
                  font-weight: bold;
                }

                .card {
                  background: white;
                  border-radius: 10px;
                  padding: 20px;
                  margin-bottom: 18px;
                  box-shadow:
                    0 2px 8px rgba(0, 0, 0, 0.08);
                }

                .card h2 {
                  margin-top: 0;
                  border-bottom: 2px solid #17324d;
                  padding-bottom: 8px;
                }

                .photo-field {
                  margin-bottom: 22px;
                }

                .photo-field label {
                  display: block;
                  margin-bottom: 7px;
                  font-size: 17px;
                  font-weight: bold;
                }

                .photo-field p {
                  margin: 0 0 9px;
                  color: #526572;
                  line-height: 1.4;
                }

                input[type="file"],
                input[type="text"] {
                  width: 100%;
                  border: 1px solid #b8c3cc;
                  border-radius: 6px;
                  padding: 11px;
                  background: white;
                  color: #1f2933;
                  font: inherit;
                }

                .preview {
                  display: none;
                  width: 100%;
                  max-height: 260px;
                  margin-top: 12px;
                  object-fit: contain;
                  background: #eef2f5;
                  border: 1px solid #d7dee3;
                  border-radius: 7px;
                }

                button {
                  width: 100%;
                  border: 0;
                  border-radius: 7px;
                  padding: 14px 18px;
                  background: #17324d;
                  color: white;
                  cursor: pointer;
                  font-size: 17px;
                  font-weight: bold;
                }

                button:disabled {
                  background: #7b8994;
                  cursor: wait;
                }

                #upload-message {
                  min-height: 24px;
                  margin-bottom: 0;
                  color: #465866;
                  font-weight: bold;
                }

                .required {
                  color: #a32626;
                }
              </style>
            </head>

            <body>
              <header>
                <h1>New Equipment Intake</h1>
              </header>

              <main>
                <a class="back" href="/plugins/signalk-quartermaster/home">
                  ← Quartermaster home
                </a><br>
                <a class="back" href="../intakes">
                  ← Return to intake list
                </a>

                <form
                  id="intake-upload-form"
                  enctype="multipart/form-data"
                >
                  <div class="card">
                    <h2>Equipment Information</h2>

                    <label for="location-note">
                      Location Note
                    </label>

                    <input
                      id="location-note"
                      name="location_note"
                      type="text"
                      maxlength="300"
                      placeholder="Example: Engine room, port side"
                    >
                  </div>

                  <div class="card">
                    <h2>Photographs</h2>

                    <div class="photo-field">
                      <label for="equipment-photo">
                        Equipment
                        <span class="required">*</span>
                      </label>

                      <p>
                        Take a clear photograph of the entire
                        equipment item.
                      </p>

                      <input
                        id="equipment-photo"
                        name="equipment"
                        type="file"
                        accept="image/*"
                        required
                      >

                      <img
                        id="equipment-preview"
                        class="preview"
                        alt="Equipment preview"
                      >
                    </div>

                    <div class="photo-field">
                      <label for="nameplate-photo">
                        Nameplate
                        <span class="required">*</span>
                      </label>

                      <p>
                        Photograph the manufacturer label,
                        model, serial number, or ratings plate.
                      </p>

                      <input
                        id="nameplate-photo"
                        name="nameplate"
                        type="file"
                        accept="image/*"
                        required
                      >

                      <img
                        id="nameplate-preview"
                        class="preview"
                        alt="Nameplate preview"
                      >
                    </div>

                    <div class="photo-field">
                      <label for="location-photo">
                        Installation Location
                        <span class="required">*</span>
                      </label>

                      <p>
                        Show where the equipment is installed
                        aboard the vessel.
                      </p>

                      <input
                        id="location-photo"
                        name="location"
                        type="file"
                        accept="image/*"
                        required
                      >

                      <img
                        id="location-preview"
                        class="preview"
                        alt="Location preview"
                      >
                    </div>
                  </div>

                  <div class="card">
                    <button id="upload-button" type="submit">
                      Create Equipment Intake
                    </button>

                    <p
                      id="upload-message"
                      aria-live="polite"
                    ></p>
                  </div>
                </form>
              </main>

              <script>
                (() => {
                  const form =
                    document.getElementById(
                      'intake-upload-form'
                    )

                  const button =
                    document.getElementById(
                      'upload-button'
                    )

                  const message =
                    document.getElementById(
                      'upload-message'
                    )

                  const photoFields = [
                    [
                      'equipment-photo',
                      'equipment-preview'
                    ],
                    [
                      'nameplate-photo',
                      'nameplate-preview'
                    ],
                    [
                      'location-photo',
                      'location-preview'
                    ]
                  ]

                  photoFields.forEach((field) => {
                    const input =
                      document.getElementById(field[0])

                    const preview =
                      document.getElementById(field[1])

                    input.addEventListener(
                      'change',
                      () => {
                        const file = input.files[0]

                        if (!file) {
                          preview.removeAttribute('src')
                          preview.style.display = 'none'
                          return
                        }

                        preview.src =
                          URL.createObjectURL(file)

                        preview.style.display = 'block'
                      }
                    )
                  })

                  form.addEventListener(
                    'submit',
                    async (event) => {
                      event.preventDefault()

                      if (!form.reportValidity()) {
                        return
                      }

                      button.disabled = true
                      message.textContent =
                        'Uploading and preparing photographs...'

                      try {
                        const uploadUrl =
                          window.location.pathname.replace(
                            /\\/new$/,
                            '/upload'
                          )

                        const response =
                          await fetch(
                            uploadUrl,
                            {
                              method: 'POST',
                              credentials: 'same-origin',
                              body: new FormData(form)
                            }
                          )

                        const responseText =
                          await response.text()

                        let result = {}

                        try {
                          result =
                            JSON.parse(responseText)
                        } catch {
                          result = {}
                        }

                        if (
                          response.status === 401 ||
                          response.status === 403
                        ) {
                          throw new Error(
                            'Please sign in to Signal K ' +
                            'with read-write access, then ' +
                            'try again.'
                          )
                        }

                        if (!response.ok) {
                          throw new Error(
                            result.error ||
                            responseText ||
                            'Upload failed'
                          )
                        }

                        message.textContent =
                          'Intake created. Opening review...'

                        window.location.href =
                          result.review_url
                      } catch (error) {
                        message.textContent =
                          error instanceof Error
                            ? error.message
                            : 'Upload failed'

                        button.disabled = false
                      }
                    }
                  )
                })()
              </script>
            </body>
            </html>
          `)
        }
      )
 /*
       * Quartermaster phone intake upload
       *
       * Requires Signal K read-write access.
       */
      router.access('readwrite').post(
        '/intakes/upload',
        (req: any, res: any) => {
          intakePhotoUpload(
            req,
            res,
            async (uploadErr: any) => {
              if (uploadErr) {
                const tooLarge =
                  uploadErr.code === 'LIMIT_FILE_SIZE'

                res.status(tooLarge ? 413 : 400).json({
                  ok: false,
                  error: tooLarge
                    ? 'Each photograph must be 12 MB or smaller.'
                    : `Upload failed: ${uploadErr.message}`
                })

                return
              }

              const uploadedFiles =
                req.files as {
                  [fieldName: string]: Express.Multer.File[]
                } | undefined

              const equipmentFile =
                uploadedFiles?.equipment?.[0]

              const nameplateFile =
                uploadedFiles?.nameplate?.[0]

              const locationFile =
                uploadedFiles?.location?.[0]

              if (
                !equipmentFile ||
                !nameplateFile ||
                !locationFile
              ) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Equipment, nameplate, and location ' +
                    'photographs are required.'
                })

                return
              }

              const allowedTypes = new Set([
                'image/jpeg',
                'image/png',
                'image/webp',
                'image/heic',
                'image/heif',
                'image/tiff'
              ])

              const invalidFile = [
                equipmentFile,
                nameplateFile,
                locationFile
              ].find(
                (file) => !allowedTypes.has(file.mimetype)
              )

              if (invalidFile) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Photographs must be JPEG, PNG, WebP, ' +
                    'HEIC, HEIF, or TIFF files.'
                })

                return
              }
      const databaseFile =
                currentSettings.databaseFile ||
                'quartermaster.db'

              const dbPath =
                path.join(dataDir, databaseFile)

              const vesselUuid =
                (app.getSelfPath('uuid') ?? (app as any).selfId)

              const locationNote =
                String(req.body?.location_note || '')
                  .trim()
                  .slice(0, 500)

              const intakeRoot = path.join(
                dataDir,
                'storage',
                'intake'
              )

              const stagingRoot = path.join(
                intakeRoot,
                '.staging'
              )

              let stagingDir = ''
              let finalDir = ''
              let db: any = null
              let transactionStarted = false

              try {
                if (!vesselUuid) {
                  throw new Error(
                    'Signal K vessel UUID is unavailable'
                  )
                }

                await fs.promises.mkdir(
                  stagingRoot,
                  {
                    recursive: true
                  }
                )

                stagingDir =
                  await fs.promises.mkdtemp(
                    path.join(
                      stagingRoot,
                      'upload-'
                    )
                  )

                const photographs = [
                  {
                    file: equipmentFile,
                    output: 'equipment.jpg'
                  },
                  {
                    file: nameplateFile,
                    output: 'nameplate.jpg'
                  },
                  {
                    file: locationFile,
                    output: 'location.jpg'
                  }
                ]

                for (const photograph of photographs) {
                  await sharp(
                    photograph.file.buffer,
                    {
                      failOn: 'error',
                      limitInputPixels: 40000000
                    }
                  )
                    .rotate()
                    .resize({
                      width: 2400,
                      height: 2400,
                      fit: 'inside',
                      withoutEnlargement: true
                    })
                    .jpeg({
                      quality: 85,
                      mozjpeg: true
                    })
                    .toFile(
                      path.join(
                        stagingDir,
                        photograph.output
                      )
                    )
                }

                db = await new Promise<any>(
                  (resolve, reject) => {
                    const database =
                      new sqlite3.Database(
                        dbPath,
                        sqlite3.OPEN_READWRITE,
                        (openErr: Error | null) => {
                          if (openErr) {
                            reject(openErr)
                            return
                          }

                          resolve(database)
                        }
                      )
                  }
                )

                const runDb = (
                  sql: string,
                  parameters: any[] = []
                ) =>
                  new Promise<{
                    lastID: number
                    changes: number
                  }>((resolve, reject) => {
                    db.run(
                      sql,
                      parameters,
                      function (
                        this: {
                          lastID: number
                          changes: number
                        },
                        runErr: Error | null
                      ) {
                        if (runErr) {
                          reject(runErr)
                          return
                        }

                        resolve({
                          lastID: this.lastID,
                          changes: this.changes
                        })
                      }
                    )
                  })

                const getDb = (
                  sql: string,
                  parameters: any[] = []
                ) =>
                  new Promise<any>(
                    (resolve, reject) => {
                      db.get(
                        sql,
                        parameters,
                        (
                          queryErr: Error | null,
                          row: any
                        ) => {
                          if (queryErr) {
                            reject(queryErr)
                            return
                          }

                          resolve(row)
                        }
                      )
                    }
                  )

                await runDb('BEGIN IMMEDIATE')
                transactionStarted = true

                const vessel = await getDb(
                  `
                    SELECT id
                    FROM vessels
                    WHERE signalk_uuid = ?
                  `,
                  [vesselUuid]
                )

                if (!vessel) {
                  throw new Error(
                    'Signal K vessel is not registered'
                  )
                }

                const sequence = await getDb(`
                  SELECT
                    COALESCE(
                      MAX(
                        CAST(
                          SUBSTR(intake_code, 8)
                          AS INTEGER
                        )
                      ),
                      0
                    ) + 1 AS next_number
                  FROM asset_intakes
                  WHERE intake_code
                    LIKE 'INTAKE-%'
                `)

                const nextNumber =
                  Number(sequence.next_number)

                const intakeCode =
                  `INTAKE-${String(nextNumber).padStart(
                    6,
                    '0'
                  )}`

                const storagePath =
                  `storage/intake/${intakeCode}`

                finalDir = path.join(
                  intakeRoot,
                  intakeCode
                )

                await fs.promises.rename(
                  stagingDir,
                  finalDir
                )

                stagingDir = ''

                await runDb(
                  `
                    INSERT INTO asset_intakes (
                      vessel_id,
                      intake_code,
                      status,
                      storage_path,
                      location_note
                    )
                    VALUES (?, ?, 'pending', ?, ?)
                  `,
                  [
                    vessel.id,
                    intakeCode,
                    storagePath,
                    locationNote || null
                  ]
                )

                await runDb('COMMIT')
                transactionStarted = false

                db.close()
                db = null

                res.status(201).json({
                  ok: true,
                  intake: {
                    intake_code: intakeCode,
                    status: 'pending'
                  },
                  review_url:
                    `/plugins/${plugin.id}/intakes/` +
                    encodeURIComponent(intakeCode)
                })
              } catch (error) {
                if (db && transactionStarted) {
                  try {
                    await new Promise<void>(
                      (resolve) => {
                        db.run(
                          'ROLLBACK',
                          () => resolve()
                        )
                      }
                    )
                  } catch {
                    // Preserve the original error.
                  }
                }

                if (db) {
                  db.close()
                }

                if (stagingDir) {
                  await fs.promises.rm(
                    stagingDir,
                    {
                      recursive: true,
                      force: true
                    }
                  )
                }

                if (finalDir) {
                  await fs.promises.rm(
                    finalDir,
                    {
                      recursive: true,
                      force: true
                    }
                  )
                }

                const message =
                  error instanceof Error
                    ? error.message
                    : 'Unknown upload error'

                app.error(
                  `Quartermaster intake upload failed: ${message}`
                )

                res.status(500).json({
                  ok: false,
                  error:
                    'Unable to create the equipment intake.'
                })
              }
            }
          )
        }
      )
      /*
       * Analyze an equipment intake with AI.
       *
       * Requires authenticated Signal K read-write access.
       */
      router.access('readwrite').post(
        '/intakes/:intakeCode/analyze',
        async (req: any, res: any) => {
          const intakeCode = String(
            req.params.intakeCode || ''
          )

          if (activeAnalyses.has(intakeCode)) {
            res.status(409).json({
              ok: false,
              error: 'This intake is already being analyzed'
            })

            return
          }

          activeAnalyses.add(intakeCode)

          try {
            const result = await analyzeIntake({
              dataDir,

              databaseFile:
                currentSettings.databaseFile ||
                'quartermaster.db',

              intakeCode,
              aiMode: currentSettings.aiMode || 'direct',
              trialServiceUrl: currentSettings.trialServiceUrl
            })

            res.status(200).json({
              ok: true,
              intake_code: result.intakeCode,
              status: 'ai_complete',
              model: result.model,
              photographs: result.photographs,

              review_url:
                `/plugins/${plugin.id}/intakes/` +
                encodeURIComponent(result.intakeCode)
            })
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : 'AI analysis failed'

            const safeLogMessage = message.replace(
              /sk-[A-Za-z0-9_-]+/g,
              '[redacted]'
            )

            app.error(
              `AI analysis failed for ${intakeCode}: ` +
              safeLogMessage
            )

            if (message.startsWith('Trial:')) {
              res.status(message.includes('allowance exhausted') ? 402 : 503).json({ ok: false, error: message })
              return
            }
            let statusCode = 500
            let publicMessage = 'AI analysis failed'

            if (message === 'Invalid intake code') {
              statusCode = 400
              publicMessage = message
            } else if (
              message === 'Intake record not found'
            ) {
              statusCode = 404
              publicMessage = message
            } else if (
              message ===
              'Approved intakes cannot be analyzed again'
            ) {
              statusCode = 409
              publicMessage = message
            } else if (
              message ===
              'At least one intake photograph is required ' +
              'for AI analysis'
            ) {
              statusCode = 400
              publicMessage = message
            } else if (
              message ===
              'The OpenAI API key is not configured'
            ) {
              statusCode = 503
              publicMessage =
                'AI analysis is not configured on this server'
            }

            res.status(statusCode).json({
              ok: false,
              error: publicMessage
            })
          } finally {
            activeAnalyses.delete(intakeCode)
          }
        }
      )

      /*
       * Quartermaster intake review list
       *
       * Read-only list of equipment intakes awaiting review
       * or previously approved.
       */
      
      router.access('readonly').get(
        '/intakes',
        (_req: any, res: any) => {
          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(
                  `Unable to open Quartermaster database: ${openErr.message}`
                )

                res.status(500).send(
                  '<h1>Quartermaster</h1>' +
                  '<p>Unable to open the intake database.</p>'
                )

                return
              }

              const sql = `
                SELECT
                  id,
                  intake_code,
                  status,
                  ai_provider,
                  ai_model,
                  approved_asset_id,
                  reviewed_by,
                  reviewed_at
                FROM asset_intakes
                ORDER BY id DESC
              `

              db.all(
                sql,
                [],
                (queryErr: Error | null, intakes: any[]) => {
                  if (queryErr) {
                    app.error(
                      `Quartermaster intake list failed: ${queryErr.message}`
                    )

                    res.status(500).send(
                      '<h1>Quartermaster</h1>' +
                      '<p>Unable to retrieve the intake list.</p>'
                    )

                    db.close()
                    return
                  }

                  const escapeHtml = (input: any) => {
                    if (
                      input === null ||
                      input === undefined ||
                      input === ''
                    ) {
                      return '—'
                    }

                    return String(input)
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&#039;')
                  }

                  const rows = intakes.map((intake) => `
                    <tr>
                      <td>
                        <a href="./intakes/${encodeURIComponent(
                          intake.intake_code
                        )}">
                          ${escapeHtml(intake.intake_code)}
                        </a>
                      </td>
                      <td>${escapeHtml(intake.status)}</td>
                      <td>${escapeHtml(intake.ai_provider)}</td>
                      <td>${escapeHtml(intake.ai_model)}</td>
                      <td>${escapeHtml(intake.approved_asset_id)}</td>
                      <td>${escapeHtml(intake.reviewed_by)}</td>
                      <td>${escapeHtml(intake.reviewed_at)}</td>
                    </tr>
                  `).join('')

                  res.status(200).send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                      <meta charset="UTF-8">
                      <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1"
                      >
                      <title>Equipment Intakes | Quartermaster</title>
                      <style>
                        * {
                          box-sizing: border-box;
                        }

                        body {
                          margin: 0;
                          background: #f4f6f8;
                          color: #1f2933;
                          font-family: Arial, Helvetica, sans-serif;
                        }

                        header {
                          background: #17324d;
                          color: white;
                          padding: 22px 20px;
                        }

                        header h1 {
                          margin: 0;
                        }

                        main {
                          max-width: 1100px;
                          margin: auto;
                          padding: 20px;
                        }

                        .card {
                          overflow-x: auto;
                          background: white;
                          border-radius: 10px;
                          padding: 20px;
                          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
                        }

                        table {
                          width: 100%;
                          border-collapse: collapse;
                        }

                        th,
                        td {
                          padding: 12px;
                          border-bottom: 1px solid #e4e8eb;
                          text-align: left;
                          white-space: nowrap;
                        }

                        th {
                          background: #eef2f5;
                          color: #465866;
                        }

.photo-grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(180px, 240px));
  justify-content: center;
  gap: 18px;
}

.photo {
  margin: 0;
  max-width: 240px;
}

.photo img {
  display: block;
  width: 100%;
  height: 180px;
  object-fit: contain;
  background: #eef2f5;
  border: 1px solid #d7dee3;
  border-radius: 7px;
}
                        .photo figcaption {
                          padding-top: 8px;
                          color: #465866;
                          font-weight: bold;
                          text-align: center;
                        }

                        a {
                          color: #0b6395;
                          font-weight: bold;
                        }

                        .empty {
                          color: #667784;
                        }
                      </style>
                    </head>
                    <body>
                      <header>
                        <h1>Quartermaster Equipment Intakes</h1>
                      </header>

                      <main>
                        <p><a href="/plugins/signalk-quartermaster/home">
                          ← Quartermaster home
                        </a></p>
                        <div class="card">
                          ${
                            intakes.length === 0
                              ? '<p class="empty">No equipment intakes found.</p>'
                              : `
                                <table>
                                  <thead>
                                    <tr>
                                      <th>Intake</th>
                                      <th>Status</th>
                                      <th>AI Provider</th>
                                      <th>AI Model</th>
                                      <th>Asset ID</th>
                                      <th>Reviewed By</th>
                                      <th>Reviewed At</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    ${rows}
                                  </tbody>
                                </table>
                              `
                          }
                        </div>
                      </main>
                    </body>
                    </html>
                  `)

                  db.close()
                }
              )
            }
          )
        }
      )
 /*
       * Quartermaster intake photograph
       *
       * Serves only the three approved intake photograph names.
       */
      router.access('readonly').get(
        '/intakes/:intakeCode/photos/:fileName',
        (req: any, res: any) => {
          const intakeCode = req.params.intakeCode
          const fileName = req.params.fileName

          const validIntakeCode = /^INTAKE-\d{6}$/

          const allowedFiles = [
            'equipment.jpg',
            'location.jpg',
            'nameplate.jpg'
          ]

          if (
            !validIntakeCode.test(intakeCode) ||
            !allowedFiles.includes(fileName)
          ) {
            res.status(404).json({
              ok: false,
              error: 'Photograph not found'
            })

            return
          }

          const photoPath = path.join(
            dataDir,
            'storage',
            'intake',
            intakeCode,
            fileName
          )

          res.sendFile(
            photoPath,
            (sendErr: any) => {
              if (sendErr && !res.headersSent) {
                app.error(
                  `Unable to send intake photograph: ${sendErr.message}`
                )

                res.status(404).json({
                  ok: false,
                  error: 'Photograph not found'
                })
              }
            }
          )
        }
      )

      /*
       * Quartermaster individual intake review page
       *
       * Read-only view of the intake record and AI results.
       */
      router.access('readonly').get(
        '/intakes/:intakeCode',
        (req: any, res: any) => {
          const intakeCode = req.params.intakeCode

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(
                  `Unable to open Quartermaster database: ${openErr.message}`
                )

                res.status(500).send(
                  '<h1>Quartermaster</h1>' +
                  '<p>Unable to open the intake database.</p>'
                )

                return
              }

              const sql = `
                SELECT
                  i.id,
                  i.intake_code,
                  i.status,
                  i.storage_path,
                  i.location_note,
                  i.ai_result_json,
                  i.ai_provider,
                  i.ai_model,
                  i.approved_asset_id,
                  i.reviewed_by,
                  i.reviewed_at,
                  i.created_at,
                  i.updated_at,
                  a.name AS approved_asset_name,
                  a.qr_code AS approved_asset_qr
                FROM asset_intakes i
                LEFT JOIN assets a
                  ON i.approved_asset_id = a.id
                WHERE i.intake_code = ?
              `

              db.get(
                sql,
                [intakeCode],
                (queryErr: Error | null, intake: any) => {
                  if (queryErr) {
                    app.error(
                      `Quartermaster intake lookup failed: ${queryErr.message}`
                    )

                    res.status(500).send(
                      '<h1>Quartermaster</h1>' +
                      '<p>Unable to retrieve the intake record.</p>'
                    )

                    db.close()
                    return
                  }

                  if (!intake) {
                    res.status(404).send(
                      '<h1>Quartermaster</h1>' +
                      '<h2>Intake Not Found</h2>' +
                      `<p>No record was found for ${intakeCode}.</p>`
                    )

                    db.close()
                    return
                  }

                  const escapeHtml = (input: any) => {
                    if (
                      input === null ||
                      input === undefined ||
                      input === ''
                    ) {
                      return '—'
                    }

                    return String(input)
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&#039;')
                  }
                  const formValue = (input: any) => {
                    if (
                      input === null ||
                      input === undefined
                    ) {
                      return ''
                    }

                    return escapeHtml(input)
                  }
                  let aiResult: any = {}

                  try {
                    aiResult = JSON.parse(
                      intake.ai_result_json || '{}'
                    )
                  } catch {
                    aiResult = {
                      uncertainty_notes: [
                        'The saved AI result could not be read.'
                      ]
                    }
                  }

                  const uncertaintyNotes =
                    Array.isArray(aiResult.uncertainty_notes)
                      ? aiResult.uncertainty_notes
                          .map(
                            (note: any) =>
                              `<li>${escapeHtml(note)}</li>`
                          )
                          .join('')
                      : '<li>None recorded.</li>'

                  const approvedAssetLink =
                    intake.approved_asset_qr
                      ? `
                        <a href="../asset/${
                          encodeURIComponent(
                            intake.approved_asset_qr
                          )
                        }">
                          ${escapeHtml(
                            intake.approved_asset_name
                          )}
                        </a>
                      `
                      : '—'
                  const analysisPanel =
                    intake.approved_asset_id
                      ? ''
                      : intake.status === 'ai_complete'
                        ? `
                          <div class="card">
                            <h2>AI Analysis</h2>

                            <p>
                              AI analysis is complete. Review the
                              proposed information and photographs
                              before approving this intake.
                            </p>
                          </div>
                        `
                        : `
                          <div class="card">
                            <h2>AI Analysis</h2>

                            <p>
                              Analyze the uploaded photographs to
                              prepare proposed equipment information.
                              A person must review and correct the
                              result before approval.
                            </p>

                            <p>
                              Before analyzing, confirm that you are
                              signed in to the
                              <a
                                href="/admin/#/dashboard"
                                target="_blank"
                                rel="noopener"
                              >
                                Signal K dashboard
                              </a>
                              using this same browser address.
                            </p>

                            <button
                              id="analyze-button"
                              type="button"
                            >
                              ${
                                intake.status === 'analysis_failed'
                                  ? 'Retry AI Analysis'
                                  : 'Analyze with AI'
                              }
                            </button>

                            <p
                              id="analysis-message"
                              aria-live="polite"
                            ></p>

                            <script>
                              (() => {
                                const button =
                                  document.getElementById(
                                    'analyze-button'
                                  )

                                const message =
                                  document.getElementById(
                                    'analysis-message'
                                  )

                                if (!button || !message) {
                                  return
                                }

                                const trialMode = ${currentSettings.aiMode === 'trial' ? 'true' : 'false'}
                                if (trialMode) {
                                  fetch('/plugins/signalk-quartermaster/ai/status', {credentials: 'same-origin'})
                                    .then(r => r.json()).then(s => {
                                      message.textContent = s.ok ? s.remaining + ' of 5 AI identifications remaining. ' +
                                        (s.pending ? s.pending + ' pending. ' : '') +
                                        'Photographs are sent to OpenOceanOS and OpenAI for identification.' : s.error
                                    }).catch(() => { message.textContent = 'Trial service unavailable. Manual entry remains available.' })
                                }
                                button.addEventListener(
                                  'click',
                                  async () => {
                                    if (trialMode && !window.confirm('Send these equipment photographs to OpenOceanOS and OpenAI? A successful new identification uses one of your five included lookups.')) return
                                    button.disabled = true
                                    message.textContent =
                                      'Analyzing photographs...'

                                    try {
                                      const response =
                                        await fetch(
                                          window.location.pathname +
                                            '/analyze',
                                          {
                                            method: 'POST',
                                            credentials: 'same-origin'
                                          }
                                        )

                                      const responseText =
                                        await response.text()

                                      let result = {}

                                      try {
                                        result =
                                          JSON.parse(responseText)
                                      } catch {
                                        result = {}
                                      }

                                      if (
                                        response.status === 401 ||
                                        response.status === 403
                                      ) {
                                        throw new Error(
                                          'Please sign in to ' +
                                            'Signal K with ' +
                                            'read-write access, ' +
                                            'then try again.'
                                        )
                                      }

                                      if (!response.ok) {
                                        throw new Error(
                                          result.error ||
                                            responseText ||
                                            'AI analysis failed'
                                        )
                                      }

                                      message.textContent =
                                        'Analysis complete. ' +
                                        'Refreshing review...'

                                      window.location.reload()
                                    } catch (error) {
                                      message.textContent =
                                        error instanceof Error
                                          ? error.message
                                          : 'AI analysis failed'

                                      button.disabled = false
                                    }
                                  }
                                )
                              })()
                            </script>
                          </div>
                        `

                  const approvalPanel =
                    intake.approved_asset_id
                      ? `
                        <div class="card">
                          <h2>Approval</h2>

                          <p>
                            This intake has already been
                            approved and linked to:
                            ${approvedAssetLink}
                          </p>
                        </div>
                      `
                      : `
                        <div class="card">
                          <h2>Review and Approve</h2>

                          <p>
                            Review the AI information below.
                            Correct any errors before creating
                            the permanent asset record.
                          </p>

                          <form id="approval-form">
                            <div class="form-grid">
                              <label>
                                Equipment Name
                                <input
                                  name="name"
                                  required
                                  maxlength="200"
                                  value="${
                                    formValue(
                                      aiResult.equipment_name
                                    )
                                  }"
                                >
                              </label>

                              <label>
                                Category
                                <input
                                  name="category"
                                  maxlength="100"
                                  value="${
                                    formValue(
                                      aiResult.category
                                    )
                                  }"
                                >
                              </label>

                              <label>
                                Manufacturer
                                <input
                                  name="manufacturer"
                                  maxlength="150"
                                  value="${
                                    formValue(
                                      aiResult.manufacturer
                                    )
                                  }"
                                >
                              </label>

                              <label>
                                Model
                                <input
                                  name="model"
                                  maxlength="150"
                                  value="${
                                    formValue(
                                      aiResult.model
                                    )
                                  }"
                                >
                              </label>

                              <label>
                                Serial Number
                                <input
                                  name="serial_number"
                                  maxlength="150"
                                  value="${
                                    formValue(
                                      aiResult.serial_number
                                    )
                                  }"
                                >
                              </label>

                              <label>
                                Part Number
                                <input
                                  name="part_number"
                                  maxlength="150"
                                  value="${
                                    formValue(
                                      aiResult.part_number
                                    )
                                  }"
                                >
                              </label>

                              <label class="full-width">
                                Location
                                <input
                                  name="location"
                                  maxlength="200"
                                  value="${
                                    formValue(
                                      aiResult.location_suggestion
                                    )
                                  }"
                                >
                              </label>

                              <label class="full-width">
                                Description
                                <textarea
                                  name="description"
                                  maxlength="2000"
                                  rows="4"
                                ></textarea>
                              </label>

                              <label class="full-width">
                                Notes
                                <textarea
                                  name="notes"
                                  maxlength="4000"
                                  rows="4"
                                ></textarea>
                              </label>
                            </div>

                              <p>
                              Before approving, confirm that you are
                              signed in to the
                              <a
                                href="/admin/#/dashboard"
                                target="_blank"
                                rel="noopener"
                              >
                                Signal K dashboard
                              </a>
                              using this same browser address.
                            </p>

                            <button
                              id="approve-button"
                              type="button"
                            >
                              Approve and Create Asset
                            </button>

                            <p
                              id="approval-message"
                              aria-live="polite"
                            ></p>
                          </form>

                          <script>
                            (() => {
                              const form =
                                document.getElementById(
                                  'approval-form'
                                )

                              const button =
                                document.getElementById(
                                  'approve-button'
                                )

                              const message =
                                document.getElementById(
                                  'approval-message'
                                )

                              if (!form || !button || !message) {
                                return
                              }

                              button.addEventListener(
                                'click',
                                async () => {
                                  if (!form.reportValidity()) {
                                    return
                                  }

                                  button.disabled = true
                                  message.textContent =
                                    'Creating asset...'

                                  const submitted =
                                    Object.fromEntries(
                                      new FormData(form).entries()
                                    )

                                  try {
                                    const response =
                                      await fetch(
                                        window.location.pathname +
                                          '/approve',
                                        {
                                          method: 'POST',
                                          credentials: 'same-origin',
                                          headers: {
                                            'Content-Type':
                                              'text/plain'
                                          },
                                          body: JSON.stringify(
                                            submitted
                                          )
                                        }
                                      )

                                    const responseText =
                                      await response.text()

                                    let result = {}

                                    try {
                                      result =
                                        JSON.parse(responseText)
                                    } catch {
                                      result = {}
                                    }

                                    if (
                                      response.status === 401 ||
                                      response.status === 403
                                    ) {
                                      throw new Error(
                                        'Please sign in to ' +
                                          'Signal K with ' +
                                          'read-write access, ' +
                                          'then try again.'
                                      )
                                    }

                                    if (!response.ok) {
                                      throw new Error(
                                        result.error ||
                                          responseText ||
                                          'Approval failed'
                                      )
                                    }

                                    message.textContent =
                                      'Asset created. ' +
                                      'Opening record...'

                                    window.location.href =
                                      '../asset/' +
                                      encodeURIComponent(
                                        result.asset.qr_code
                                      )
                                  } catch (error) {
                                     const errorMessage =
                                      error instanceof Error
                                        ? error.message
                                        : 'Approval failed'

                                    if (
                                      errorMessage ===
                                      'Failed to fetch'
                                    ) {
                                      message.innerHTML =
                                        'Approval could not reach an ' +
                                        'authenticated Signal K session. ' +
                                        '<a href="/admin/#/dashboard" ' +
                                        'target="_blank" ' +
                                        'rel="noopener">' +
                                        'Open the Signal K dashboard' +
                                        '</a>, sign in, then return ' +
                                        'and try once.'
                                    } else {
                                      message.textContent =
                                        errorMessage
                                    }

                                    button.disabled = false
                                  }
                                }
                              )
                            })()
                          </script>
                        </div>
                      `

                  res.status(200).send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                      <meta charset="UTF-8">

                      <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1"
                      >

                      <title>
                        ${escapeHtml(intake.intake_code)}
                        | Quartermaster
                      </title>

                      <style>
                        * {
                          box-sizing: border-box;
                        }

                        body {
                          margin: 0;
                          background: #f4f6f8;
                          color: #1f2933;
                          font-family:
                            Arial,
                            Helvetica,
                            sans-serif;
                        }

                        header {
                          background: #17324d;
                          color: white;
                          padding: 22px 20px;
                        }

                        header h1 {
                          margin: 0;
                        }

                        main {
                          max-width: 900px;
                          margin: auto;
                          padding: 20px;
                        }

                        .back {
                          display: inline-block;
                          margin-bottom: 16px;
                          color: #0b6395;
                        }

                        .card {
                          background: white;
                          border-radius: 10px;
                          padding: 22px;
                          margin-bottom: 20px;
                          box-shadow:
                            0 2px 8px rgba(0, 0, 0, 0.08);
                        }

                        .card h2 {
                          margin-top: 0;
                          border-bottom: 2px solid #17324d;
                          padding-bottom: 8px;
                        }

                        .row {
                          border-bottom: 1px solid #e4e8eb;
                          padding: 11px 0;
                        }

                        .label {
                          display: block;
                          color: #667784;
                          font-size: 12px;
                          font-weight: bold;
                          margin-bottom: 4px;
                          text-transform: uppercase;
                        }

                        .value {
                          font-size: 17px;
                          white-space: pre-wrap;
                        }

                        .status {
                          display: inline-block;
                          background: #e4f2e8;
                          color: #216e39;
                          border-radius: 14px;
                          font-weight: bold;
                          padding: 5px 11px;
                        }

                        ul {
                          line-height: 1.5;
                          padding-left: 22px;
                        }
                         
                         .form-grid {
                          display: grid;
                          grid-template-columns:
                            repeat(
                              auto-fit,
                              minmax(240px, 1fr)
                            );
                          gap: 18px;
                          margin: 20px 0;
                        }

                        .form-grid label {
                          display: flex;
                          flex-direction: column;
                          gap: 6px;
                          color: #465866;
                          font-size: 13px;
                          font-weight: bold;
                        }

                        .form-grid .full-width {
                          grid-column: 1 / -1;
                        }

                        .form-grid input,
                        .form-grid textarea {
                          width: 100%;
                          border: 1px solid #b8c3cc;
                          border-radius: 6px;
                          padding: 10px;
                          color: #1f2933;
                          background: white;
                          font: inherit;
                          font-weight: normal;
                        }

                        .form-grid input:focus,
                        .form-grid textarea:focus {
                          border-color: #0b6395;
                          outline: 2px solid #cbe8f6;
                        }

                        #approve-button,
                        #analyze-button {
                          border: 0;
                          border-radius: 6px;
                          padding: 11px 18px;
                          background: #17324d;
                          color: white;
                          cursor: pointer;
                          font-size: 16px;
                          font-weight: bold;
                        }

                        #approve-button:disabled,
                        #analyze-button:disabled {
                          background: #7b8994;
                          cursor: wait;
                        }

                        #approval-message,
                        #analysis-message {
                          min-height: 24px;
                          color: #465866;
                          font-weight: bold;
                        }

                        .photo-grid {
                          display: grid;
                          grid-template-columns:
                            repeat(
                              auto-fit,
                              minmax(180px, 240px)
                            );
                          justify-content: center;
                          gap: 18px;
                        }

                        .photo {
                          margin: 0;
                          max-width: 240px;
                        }

                        .photo img {
                          display: block;
                          width: 100%;
                          height: 180px;
                          object-fit: contain;
                          background: #eef2f5;
                          border: 1px solid #d7dee3;
                          border-radius: 7px;
                        }

                        .photo figcaption {
                          padding-top: 8px;
                          color: #465866;
                          font-weight: bold;
                          text-align: center;
                        } a {
                          color: #0b6395;
                          font-weight: bold;
                        }
                      </style>
                    </head>

                    <body>
                      <header>
                        <h1>Quartermaster Intake Review</h1>
                      </header>

                      <main>
                        <a class="back" href="/plugins/signalk-quartermaster/home">
                          ← Quartermaster home
                        </a><br>
                        <a class="back" href="../intakes">
                          ← Return to intake list
                        </a>

                        <div class="card">
                          <h2>
                            ${escapeHtml(intake.intake_code)}
                          </h2>

                          <div class="row">
                            <span class="label">Status</span>
                            <span class="status">
                              ${escapeHtml(intake.status)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Location Note
                            </span>
                            <span class="value">
                              ${escapeHtml(intake.location_note)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Created
                            </span>
                            <span class="value">
                              ${escapeHtml(intake.created_at)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Reviewed By
                            </span>
                            <span class="value">
                              ${escapeHtml(intake.reviewed_by)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Reviewed At
                            </span>
                            <span class="value">
                              ${escapeHtml(intake.reviewed_at)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Approved Asset
                            </span>
                            <span class="value">
                              ${approvedAssetLink}
                            </span>
                          </div>
                        </div>

                        ${analysisPanel}

                        <div class="card">
                          <h2>AI Identification</h2>

                          <div class="row">
                            <span class="label">
                              Equipment Name
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.equipment_name
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">Category</span>
                            <span class="value">
                              ${escapeHtml(aiResult.category)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Manufacturer
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.manufacturer
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">Model</span>
                            <span class="value">
                              ${escapeHtml(aiResult.model)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Serial Number
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.serial_number
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Part Number
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.part_number
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Suggested Location
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.location_suggestion
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Confidence
                            </span>
                            <span class="value">
                              ${escapeHtml(aiResult.confidence)}%
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Visible Specifications
                            </span>
                            <span class="value">
                              ${
                                escapeHtml(
                                  aiResult.visible_specifications
                                )
                              }
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Nameplate Text
                            </span>
                            <span class="value">
                              ${escapeHtml(aiResult.plate_text)}
                            </span>
                          </div>
                        </div>

                        <div class="card">
                          <h2>AI Uncertainty Notes</h2>
                          <ul>
                            ${uncertaintyNotes}
                          </ul>
                        </div>

                          ${approvalPanel}

                        <div class="card">
                          <h2>Photographs</h2>

                          <div class="photo-grid">
                            <figure class="photo">
                              <a
                                href="./${encodeURIComponent(
                                  intake.intake_code
                                )}/photos/equipment.jpg"
                                target="_blank"
                                rel="noopener"
                              >
                                <img
                                  src="./${encodeURIComponent(
                                    intake.intake_code
                                  )}/photos/equipment.jpg"
                                  alt="Equipment photograph"
                                >
                              </a>

                              <figcaption>
                                Equipment
                              </figcaption>
                            </figure>

                            <figure class="photo">
                              <a
                                href="./${encodeURIComponent(
                                  intake.intake_code
                                )}/photos/location.jpg"
                                target="_blank"
                                rel="noopener"
                              >
                                <img
                                  src="./${encodeURIComponent(
                                    intake.intake_code
                                  )}/photos/location.jpg"
                                  alt="Equipment location photograph"
                                >
                              </a>

                              <figcaption>
                                Location
                              </figcaption>
                            </figure>

                            <figure class="photo">
                              <a
                                href="./${encodeURIComponent(
                                  intake.intake_code
                                )}/photos/nameplate.jpg"
                                target="_blank"
                                rel="noopener"
                              >
                                <img
                                  src="./${encodeURIComponent(
                                    intake.intake_code
                                  )}/photos/nameplate.jpg"
                                  alt="Equipment nameplate photograph"
                                >
                              </a>

                              <figcaption>
                                Nameplate
                              </figcaption>
                            </figure>
                          </div>
                        </div>
                      </main>
                    </body>
                    </html>
                  `)

                  db.close()
                }
              )
            }
          )
        }
      )

            /*
       * Approve an intake and create its permanent asset.
       *
       * Requires authenticated Signal K read-write access.
       */
               router.access('readwrite').post(
        '/intakes/:intakeCode/approve',
        (req: any, res: any) => {
          const intakeCode = String(
            req.params.intakeCode || ''
          )

          if (!/^INTAKE-\d{6}$/.test(intakeCode)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid intake code'
            })

            return
          }

          let rawBody = ''
          let requestTooLarge = false

          req.setEncoding('utf8')

          req.on('data', (chunk: string) => {
            rawBody += chunk

            if (rawBody.length > 65536) {
              requestTooLarge = true
            }
          })

          req.on('end', () => {
            if (requestTooLarge) {
              res.status(413).json({
                ok: false,
                error: 'Approval request is too large'
              })

              return
            }

            let submitted: any = {}

            try {
              submitted = JSON.parse(rawBody || '{}')
            } catch {
              res.status(400).json({
                ok: false,
                error: 'Invalid approval data'
              })

              return
            }

            const cleanText = (
              value: any,
              maximumLength: number
            ) => {
              if (
                value === null ||
                value === undefined
              ) {
                return null
              }

              const cleaned = String(value).trim()

              if (cleaned === '') {
                return null
              }

              return cleaned.slice(0, maximumLength)
            }

            const name = cleanText(
              submitted.name,
              200
            )

            if (!name) {
              res.status(400).json({
                ok: false,
                error: 'Equipment name is required'
              })

              return
            }

            const category = cleanText(
              submitted.category,
              100
            )

            const manufacturer = cleanText(
              submitted.manufacturer,
              150
            )

            const model = cleanText(
              submitted.model,
              150
            )

            const serialNumber = cleanText(
              submitted.serial_number,
              150
            )

            const partNumber = cleanText(
              submitted.part_number,
              150
            )

            const location = cleanText(
              submitted.location,
              200
            )

            const description = cleanText(
              submitted.description,
              2000
            )

            const notes = cleanText(
              submitted.notes,
              4000
            )

            const databaseFile =
              currentSettings.databaseFile ||
              'quartermaster.db'

            const dbPath = path.join(
              dataDir,
              databaseFile
            )

            const db = new sqlite3.Database(
              dbPath,
              sqlite3.OPEN_READWRITE,
              (openErr: Error | null) => {
                if (openErr) {
                  app.error(
                    `Unable to open Quartermaster database: ${
                      openErr.message
                    }`
                  )

                  res.status(500).json({
                    ok: false,
                    error:
                      'Unable to open Quartermaster database'
                  })

                  return
                }

                let responseSent = false

                const closeDatabase = () => {
                  db.close()
                }

                const failTransaction = (
                  statusCode: number,
                  message: string,
                  detail?: string
                ) => {
                  if (responseSent) {
                    return
                  }

                  responseSent = true

                  if (detail) {
                    app.error(detail)
                  }

                  db.run(
                    'ROLLBACK',
                    () => {
                      res.status(statusCode).json({
                        ok: false,
                        error: message
                      })

                      closeDatabase()
                    }
                  )
                }

                db.serialize(() => {
                  db.run(
                    'BEGIN IMMEDIATE TRANSACTION',
                    (beginErr: Error | null) => {
                      if (beginErr) {
                        failTransaction(
                          500,
                          'Unable to begin approval',
                          `Approval transaction failed: ${
                            beginErr.message
                          }`
                        )

                        return
                      }

                      db.get(
                        `
                          SELECT
                            id,
                            vessel_id,
                            status,
                            approved_asset_id
                          FROM asset_intakes
                          WHERE intake_code = ?
                        `,
                        [intakeCode],
                        (
                          intakeErr: Error | null,
                          intake: any
                        ) => {
                          if (intakeErr) {
                            failTransaction(
                              500,
                              'Unable to read intake',
                              `Intake approval lookup failed: ${
                                intakeErr.message
                              }`
                            )

                            return
                          }

                          if (!intake) {
                            failTransaction(
                              404,
                              'Intake not found'
                            )

                            return
                          }

                          if (
                            intake.status === 'approved' ||
                            intake.approved_asset_id
                          ) {
                            failTransaction(
                              409,
                              'This intake is already approved'
                            )

                            return
                          }

                          db.get(
                            `
                              SELECT
                                COALESCE(
                                  MAX(
                                    CAST(
                                      SUBSTR(qr_code, 10)
                                      AS INTEGER
                                    )
                                  ),
                                  0
                                ) AS max_number
                              FROM assets
                              WHERE qr_code
                                GLOB 'QM-ASSET-[0-9]*'
                            `,
                            [],
                            (
                              numberErr: Error | null,
                              numberRow: any
                            ) => {
                              if (numberErr) {
                                failTransaction(
                                  500,
                                  'Unable to create asset number',
                                  `Asset number lookup failed: ${
                                    numberErr.message
                                  }`
                                )

                                return
                              }

                              const nextNumber =
                                Number(
                                  numberRow?.max_number || 0
                                ) + 1

                              const qrCode =
                                `QM-ASSET-${
                                  String(nextNumber).padStart(
                                    4,
                                    '0'
                                  )
                                }`

                              const assetUuid =
                                `urn:uuid:${
                                  crypto.randomUUID()
                                }`

                              const insertSql = `
                                INSERT INTO assets (
                                  vessel_id,
                                  asset_uuid,
                                  name,
                                  category,
                                  manufacturer,
                                  model,
                                  serial_number,
                                  part_number,
                                  location,
                                  description,
                                  status,
                                  qr_code,
                                  notes
                                )
                                VALUES (
                                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                  'active', ?, ?
                                )
                              `

                              db.run(
                                insertSql,
                                [
                                  intake.vessel_id,
                                  assetUuid,
                                  name,
                                  category,
                                  manufacturer,
                                  model,
                                  serialNumber,
                                  partNumber,
                                  location,
                                  description,
                                  qrCode,
                                  notes
                                ],
                                function (
                                    this: {
                                    lastID: number
                                  },
                                  insertErr: Error | null
                                ) {
                                  if (insertErr) {
                                    failTransaction(
                                      500,
                                      'Unable to create asset',
                                      `Asset creation failed: ${
                                        insertErr.message
                                      }`
                                    )

                                    return
                                  }

                                  const newAssetId =
                                    this.lastID

                                  const reviewedBy =
                                    cleanText(
                                      req.user?.username ||
                                      req.user?.name,
                                      150
                                    ) ||
                                    'Signal K administrator'

                                  db.run(
                                    `
                                      UPDATE asset_intakes
                                      SET
                                        status = 'approved',
                                        reviewed_by = ?,
                                        reviewed_at =
                                          CURRENT_TIMESTAMP,
                                        approved_asset_id = ?,
                                        updated_at =
                                          CURRENT_TIMESTAMP
                                      WHERE id = ?
                                        AND approved_asset_id
                                          IS NULL
                                        AND status != 'approved'
                                    `,
                                    [
                                      reviewedBy,
                                      newAssetId,
                                      intake.id
                                    ],
                                     function (
                                      this: {
                                        changes: number
                                      },
                                      updateErr:
                                        Error | null
                                    ) {
                                      if (updateErr) {
                                        failTransaction(
                                          500,
                                          'Unable to update intake',
                                          `Intake update failed: ${
                                            updateErr.message
                                          }`
                                        )

                                        return
                                      }

                                      if (this.changes !== 1) {
                                        failTransaction(
                                          409,
                                          'This intake was already approved'
                                        )

                                        return
                                      }

                                      db.run(
                                        'COMMIT',
                                        (
                                          commitErr:
                                            Error | null
                                        ) => {
                                          if (commitErr) {
                                            failTransaction(
                                              500,
                                              'Unable to complete approval',
                                              `Approval commit failed: ${
                                                commitErr.message
                                              }`
                                            )

                                            return
                                          }

                                          responseSent = true

                                          res.status(201).json({
                                            ok: true,
                                            asset: {
                                              id: newAssetId,
                                              asset_uuid:
                                                assetUuid,
                                              name,
                                              qr_code:
                                                qrCode
                                            },
                                            intake: {
                                              intake_code:
                                                intakeCode,
                                              status:
                                                'approved'
                                            }
                                          })

                                          closeDatabase()
                                        }
                                      )
                                    }
                                  )
                                }
                              )
                            }
                          )
                        }
                      )
                    }
                  )
                })
              }
            )
          })
        }
      )

       /*
       * Quartermaster asset lookup by QR code
       *
       * JSON API endpoint.
       *
       * Example:
       * /assets/qr/QM-ASSET-0001
       */

      router.access('readonly').get(
        '/assets/qr/:qrCode',
        (req: any, res: any) => {
          const qrCode = req.params.qrCode

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          app.debug(`QR lookup requested: ${qrCode}`)
          app.debug(`Quartermaster database: ${dbPath}`)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(
                  `Unable to open Quartermaster database: ${openErr.message}`
                )

                res.status(500).json({
                  ok: false,
                  error: 'Unable to open Quartermaster database'
                })

                return
              }

              const sql = `
                SELECT
                  a.id,
                  a.asset_uuid,
                  a.name,
                  a.category,
                  a.manufacturer,
                  a.model,
                  a.serial_number,
                  a.location,
                  a.description,
                  a.status,
                  a.qr_code,
                  v.id AS vessel_id,
                  v.name AS vessel_name
                FROM assets a
                JOIN vessels v
                  ON a.vessel_id = v.id
                WHERE a.qr_code = ?
              `

              db.get(
                sql,
                [qrCode],
                (queryErr: Error | null, row: any) => {
                  if (queryErr) {
                    app.error(
                      `Quartermaster QR lookup failed: ${queryErr.message}`
                    )

                    res.status(500).json({
                      ok: false,
                      error: 'Database query failed'
                    })

                    db.close()
                    return
                  }

                  if (!row) {
                    res.status(404).json({
                      ok: false,
                      error: 'Asset not found',
                      qr_code: qrCode
                    })

                    db.close()
                    return
                  }

                  res.status(200).json({
                    ok: true,
                    asset: row
                  })

                  db.close()
                }
              )
            }
          )
        }
      )

      /*
       * Print a 3 x 5 asset label on the attached HP KE103.
       *
       * Requires authenticated Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/print-label',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          if (!/^QM-ASSET-\d{4}$/.test(qrCode)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid Quartermaster QR code'
            })

            return
          }

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(
                  `Unable to open Quartermaster database: ${openErr.message}`
                )

                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the asset database'
                })

                return
              }

              db.get(
                `
                  SELECT
                    id,
                    name,
                    qr_code
                  FROM assets
                  WHERE qr_code = ?
                `,
                [qrCode],
                (queryErr: Error | null, asset: any) => {
                  db.close()

                  if (queryErr) {
                    app.error(
                      `Label asset lookup failed: ${queryErr.message}`
                    )

                    res.status(500).json({
                      ok: false,
                      error: 'Asset lookup failed'
                    })

                    return
                  }

                  if (!asset) {
                    res.status(404).json({
                      ok: false,
                      error: 'Asset not found'
                    })

                    return
                  }

                  const printScript = path.join(
                    __dirname,
                    '..',
                    'print-asset-label.js'
                  )

                  execFile(
                    process.execPath,
                    [printScript, String(asset.id), dbPath,
                      currentSettings.printerName || 'Quartermaster_Label_Printer',
                      currentSettings.labelBaseUrl || ''],
                    {
                      timeout: 30000
                    },
                    (
                      printErr: Error | null,
                      stdout: string,
                      stderr: string
                    ) => {
                      if (printErr) {
                        app.error(
                          `Asset label print failed: ${
                            stderr || printErr.message
                          }`
                        )

                        res.status(500).json({
                          ok: false,
                          error: 'Unable to print the asset label'
                        })

                        return
                      }

                      app.debug(
                        `Printed label for ${asset.qr_code}: ${stdout.trim()}`
                      )

                      res.status(200).json({
                        ok: true,
                        message: 'Asset label sent to printer',
                        asset: {
                          id: asset.id,
                          name: asset.name,
                          qr_code: asset.qr_code
                        }
                      })
                    }
                  )
                }
              )
            }
          )
        }
      )

 /*
       * Delete one document belonging to an asset.
       *
       * Requires Signal K read-write access.
       */
      router.access('readwrite').delete(
        '/asset/:qrCode/document/:documentId',
        (req: any, res: any) => {
          const qrCode = req.params.qrCode
          const documentId =
            Number.parseInt(req.params.documentId, 10)

          if (!/^QM-ASSET-\d{4}$/.test(qrCode)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid asset QR code.'
            })
            return
          }

          if (!Number.isInteger(documentId)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid document number.'
            })
            return
          }

          const databaseFile =
            currentSettings.databaseFile ||
            'quartermaster.db'

          const dbPath =
            path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error:
                    'Unable to open the asset database.'
                })
                return
              }

              db.get(
                `
                  SELECT
                    d.id,
                    d.asset_id,
                    d.file_name,
                    d.file_path
                  FROM asset_documents d
                  JOIN assets a
                    ON d.asset_id = a.id
                  WHERE a.qr_code = ?
                    AND d.id = ?
                `,
                [qrCode, documentId],
                (
                  queryErr: Error | null,
                  document: any
                ) => {
                  if (queryErr) {
                    db.close()

                    res.status(500).json({
                      ok: false,
                      error: 'Document lookup failed.'
                    })
                    return
                  }

                  if (!document) {
                    db.close()

                    res.status(404).json({
                      ok: false,
                      error: 'Document not found.'
                    })
                    return
                  }

                  const documentRoot =
                    path.resolve(
                      dataDir,
                      'storage',
                      'documents'
                    )

                  const resolvedFile =
                    path.resolve(document.file_path)

                  if (
                    !resolvedFile.startsWith(
                      documentRoot + path.sep
                    )
                  ) {
                    db.close()

                    res.status(403).json({
                      ok: false,
                      error:
                        'Document path is not permitted.'
                    })
                    return
                  }

                  let quarantineFile:
                    string | null = null

                  try {
                    if (fs.existsSync(resolvedFile)) {
                      quarantineFile =
                        `${resolvedFile}.delete-` +
                        `${Date.now()}`

                      fs.renameSync(
                        resolvedFile,
                        quarantineFile
                      )
                    }
                  } catch (fileErr) {
                    db.close()

                    app.error(
                      `Unable to prepare document deletion: ` +
                      `${fileErr}`
                    )

                    res.status(500).json({
                      ok: false,
                      error:
                        'Unable to prepare the file for deletion.'
                    })
                    return
                  }

                  db.run(
                    `
                      DELETE FROM asset_documents
                      WHERE id = ?
                        AND asset_id = ?
                    `,
                    [
                      document.id,
                      document.asset_id
                    ],
                    function (
                      this: { changes: number },
                      deleteErr: Error | null
                    ) {
                      if (
                        deleteErr ||
                        this.changes !== 1
                      ) {
                        if (
                          quarantineFile &&
                          fs.existsSync(quarantineFile)
                        ) {
                          try {
                            fs.renameSync(
                              quarantineFile,
                              resolvedFile
                            )
                          } catch (restoreErr) {
                            app.error(
                              `Document restore failed: ` +
                              `${restoreErr}`
                            )
                          }
                        }

                        db.close()

                        res.status(500).json({
                          ok: false,
                          error:
                            'Unable to delete the document record.'
                        })
                        return
                      }

                      let fileRemoved = true

                      if (
                        quarantineFile &&
                        fs.existsSync(quarantineFile)
                      ) {
                        try {
                          fs.unlinkSync(
                            quarantineFile
                          )
                        } catch (removeErr) {
                          fileRemoved = false

                          app.error(
                            `Document cleanup failed: ` +
                            `${removeErr}`
                          )
                        }
                      }

                      db.close()

                      res.status(200).json({
                        ok: true,
                        deleted: {
                          id: document.id,
                          file_name:
                            document.file_name,
                          file_removed:
                            fileRemoved
                        }
                      })
                    }
                  )
                }
              )
            }
          )
        }
      )

       /*
       * Replace the PDF file for an existing document.
       *
       * The title, document type, description, and document ID
       * remain unchanged.
       *
       * Requires Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/document/:documentId/replace',
        (req: any, res: any) => {
          documentUpload(
            req,
            res,
            (uploadErr: any) => {
              if (uploadErr) {
                const tooLarge =
                  uploadErr.code === 'LIMIT_FILE_SIZE'

                res.status(tooLarge ? 413 : 400).json({
                  ok: false,
                  error: tooLarge
                    ? 'The PDF must be 25 MB or smaller.'
                    : uploadErr.message
                })
                return
              }

              const qrCode = req.params.qrCode

              const documentId =
                Number.parseInt(
                  req.params.documentId,
                  10
                )

              const uploadedFile = req.file

              if (!/^QM-ASSET-\d{4}$/.test(qrCode)) {
                res.status(400).json({
                  ok: false,
                  error: 'Invalid asset QR code.'
                })
                return
              }

              if (!Number.isInteger(documentId)) {
                res.status(400).json({
                  ok: false,
                  error: 'Invalid document number.'
                })
                return
              }

              if (!uploadedFile) {
                res.status(400).json({
                  ok: false,
                  error: 'Select a replacement PDF.'
                })
                return
              }

              const pdfSignature =
                uploadedFile.buffer
                  .subarray(0, 5)
                  .toString('ascii')

              if (pdfSignature !== '%PDF-') {
                res.status(400).json({
                  ok: false,
                  error:
                    'The uploaded file is not a valid PDF.'
                })
                return
              }

              const databaseFile =
                currentSettings.databaseFile ||
                'quartermaster.db'

              const dbPath =
                path.join(dataDir, databaseFile)

              const db = new sqlite3.Database(
                dbPath,
                (openErr: Error | null) => {
                  if (openErr) {
                    res.status(500).json({
                      ok: false,
                      error:
                        'Unable to open the asset database.'
                    })
                    return
                  }

                  db.get(
                    `
                      SELECT
                        d.id,
                        d.asset_id,
                        d.file_name,
                        d.file_path,
                        d.title,
                        d.document_type,
                        d.description
                      FROM asset_documents d
                      JOIN assets a
                        ON d.asset_id = a.id
                      WHERE a.qr_code = ?
                        AND d.id = ?
                    `,
                    [qrCode, documentId],
                    (
                      queryErr: Error | null,
                      document: any
                    ) => {
                      if (queryErr) {
                        db.close()

                        res.status(500).json({
                          ok: false,
                          error:
                            'Document lookup failed.'
                        })
                        return
                      }

                      if (!document) {
                        db.close()

                        res.status(404).json({
                          ok: false,
                          error: 'Document not found.'
                        })
                        return
                      }

                      const documentRoot =
                        path.resolve(
                          dataDir,
                          'storage',
                          'documents'
                        )

                      const oldFilePath =
                        path.resolve(
                          document.file_path
                        )

                      if (
                        !oldFilePath.startsWith(
                          documentRoot + path.sep
                        )
                      ) {
                        db.close()

                        res.status(403).json({
                          ok: false,
                          error:
                            'Document path is not permitted.'
                        })
                        return
                      }

                      const assetDirectory =
                        path.join(
                          documentRoot,
                          qrCode
                        )

                      fs.mkdirSync(
                        assetDirectory,
                        {
                          recursive: true
                        }
                      )

                      const originalName =
                        path.basename(
                          uploadedFile.originalname
                        )

                      const cleanedName =
                        originalName
                          .replace(
                            /[^a-zA-Z0-9._-]+/g,
                            '-'
                          )
                          .replace(/^-+|-+$/g, '')

                      const nameWithoutExtension =
                        path.basename(
                          cleanedName,
                          path.extname(cleanedName)
                        ) || 'document'

                      const newFileName =
                        `${nameWithoutExtension}-` +
                        `replacement-${Date.now()}.pdf`

                      const newFilePath =
                        path.join(
                          assetDirectory,
                          newFileName
                        )

                      try {
                        fs.writeFileSync(
                          newFilePath,
                          uploadedFile.buffer,
                          {
                            flag: 'wx',
                            mode: 0o664
                          }
                        )
                      } catch (fileErr) {
                        db.close()

                        app.error(
                          `Replacement PDF write failed: ` +
                          `${fileErr}`
                        )

                        res.status(500).json({
                          ok: false,
                          error:
                            'Unable to save the replacement PDF.'
                        })
                        return
                      }

                      db.run(
                        `
                          UPDATE asset_documents
                          SET
                            file_name = ?,
                            file_path = ?
                          WHERE id = ?
                            AND asset_id = ?
                        `,
                        [
                          newFileName,
                          newFilePath,
                          document.id,
                          document.asset_id
                        ],
                        function (
                          this: { changes: number },
                          updateErr: Error | null
                        ) {
                          if (
                            updateErr ||
                            this.changes !== 1
                          ) {
                            try {
                              if (
                                fs.existsSync(
                                  newFilePath
                                )
                              ) {
                                fs.unlinkSync(
                                  newFilePath
                                )
                              }
                            } catch (cleanupErr) {
                              app.error(
                                `Replacement cleanup failed: ` +
                                `${cleanupErr}`
                              )
                            }

                            db.close()

                            res.status(500).json({
                              ok: false,
                              error:
                                'Unable to update the document record.'
                            })
                            return
                          }

                          let oldFileRemoved = true

                          if (
                            oldFilePath !==
                              path.resolve(newFilePath) &&
                            fs.existsSync(oldFilePath)
                          ) {
                            try {
                              fs.unlinkSync(
                                oldFilePath
                              )
                            } catch (removeErr) {
                              oldFileRemoved = false

                              app.error(
                                `Old PDF cleanup failed: ` +
                                `${removeErr}`
                              )
                            }
                          }

                          db.close()

                          res.status(200).json({
                            ok: true,
                            document: {
                              id: document.id,
                              asset_id:
                                document.asset_id,
                              qr_code: qrCode,
                              file_name:
                                newFileName,
                              title:
                                document.title,
                              document_type:
                                document.document_type,
                              description:
                                document.description,
                              old_file_removed:
                                oldFileRemoved
                            }
                          })
                        }
                      )
                    }
                  )
                }
              )
            }
          )
        }
      ) 

      /*
       * Upload one PDF document to an existing asset.
       *
       * Requires Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/documents/upload',
        (req: any, res: any) => {
          documentUpload(
            req,
            res,
            async (uploadErr: any) => {
              if (uploadErr) {
                const tooLarge =
                  uploadErr.code === 'LIMIT_FILE_SIZE'

                res.status(tooLarge ? 413 : 400).json({
                  ok: false,
                  error: tooLarge
                    ? 'The PDF must be 25 MB or smaller.'
                    : uploadErr.message
                })
                return
              }

              const qrCode = req.params.qrCode
              const uploadedFile = req.file
              const title =
                String(req.body.title || '').trim()
              const documentType =
                String(req.body.documentType || '').trim()
              const description =
                String(req.body.description || '').trim()

              if (!/^QM-ASSET-\d{4}$/.test(qrCode)) {
                res.status(400).json({
                  ok: false,
                  error: 'Invalid asset QR code.'
                })
                return
              }

              if (!uploadedFile) {
                res.status(400).json({
                  ok: false,
                  error: 'Select a PDF document.'
                })
                return
              }

              if (!title || title.length > 150) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Enter a title of 150 characters or fewer.'
                })
                return
              }

              if (description.length > 500) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Description must be 500 characters or fewer.'
                })
                return
              }

              const allowedTypes = new Set([
                'operator_manual',
                'installation_manual',
                'parts_manual',
                'service_manual',
                'specification',
                'wiring_diagram',
                'other'
              ])

              if (!allowedTypes.has(documentType)) {
                res.status(400).json({
                  ok: false,
                  error: 'Select a valid document type.'
                })
                return
              }

              const pdfSignature =
                uploadedFile.buffer
                  .subarray(0, 5)
                  .toString('ascii')

              if (pdfSignature !== '%PDF-') {
                res.status(400).json({
                  ok: false,
                  error:
                    'The uploaded file is not a valid PDF.'
                })
                return
              }

              const databaseFile =
                currentSettings.databaseFile ||
                'quartermaster.db'

              const dbPath =
                path.join(dataDir, databaseFile)

              const db = new sqlite3.Database(
                dbPath,
                (openErr: Error | null) => {
                  if (openErr) {
                    res.status(500).json({
                      ok: false,
                      error:
                        'Unable to open the asset database.'
                    })
                    return
                  }

                  db.get(
                    `
                      SELECT id
                      FROM assets
                      WHERE qr_code = ?
                    `,
                    [qrCode],
                    (
                      assetErr: Error | null,
                      asset: any
                    ) => {
                      if (assetErr) {
                        db.close()

                        res.status(500).json({
                          ok: false,
                          error: 'Asset lookup failed.'
                        })
                        return
                      }

                      if (!asset) {
                        db.close()

                        res.status(404).json({
                          ok: false,
                          error: 'Asset not found.'
                        })
                        return
                      }

                      const documentRoot =
                        path.join(
                          dataDir,
                          'storage',
                          'documents'
                        )

                      const assetDirectory =
                        path.join(documentRoot, qrCode)

                      fs.mkdirSync(
                        assetDirectory,
                        {
                          recursive: true
                        }
                      )

                      const originalName =
                        path.basename(
                          uploadedFile.originalname
                        )

                      const cleanedName =
                        originalName
                          .replace(
                            /[^a-zA-Z0-9._-]+/g,
                            '-'
                          )
                          .replace(/^-+|-+$/g, '')

                      const nameWithoutExtension =
                        path.basename(
                          cleanedName,
                          path.extname(cleanedName)
                        ) || 'document'

                      let storedFileName =
                        `${nameWithoutExtension}.pdf`

                      let storedFilePath =
                        path.join(
                          assetDirectory,
                          storedFileName
                        )

                      if (fs.existsSync(storedFilePath)) {
                        storedFileName =
                          `${nameWithoutExtension}-` +
                          `${Date.now()}.pdf`

                        storedFilePath =
                          path.join(
                            assetDirectory,
                            storedFileName
                          )
                      }

                      try {
                        fs.writeFileSync(
                          storedFilePath,
                          uploadedFile.buffer,
                          {
                            flag: 'wx',
                            mode: 0o664
                          }
                        )
                      } catch (fileErr) {
                        db.close()

                        app.error(
                          `Document write failed: ${fileErr}`
                        )

                        res.status(500).json({
                          ok: false,
                          error:
                            'Unable to save the PDF.'
                        })
                        return
                      }

                      db.run(
                        `
                          INSERT INTO asset_documents (
                            asset_id,
                            file_name,
                            file_path,
                            title,
                            document_type,
                            description
                          )
                          VALUES (?, ?, ?, ?, ?, ?)
                        `,
                        [
                          asset.id,
                          storedFileName,
                          storedFilePath,
                          title,
                          documentType,
                          description || null
                        ],
                        function (
                        this: { lastID: number },  
                        insertErr: Error | null
                        ) {
                          if (insertErr) {
                            try {
                              fs.unlinkSync(
                                storedFilePath
                              )
                            } catch {
                              // Preserve the database error.
                            }

                            db.close()

                            res.status(500).json({
                              ok: false,
                              error:
                                'Unable to register the document.'
                            })
                            return
                          }

                          const documentId =
                            this.lastID

                          db.close()

                          res.status(201).json({
                            ok: true,
                            document: {
                              id: documentId,
                              asset_id: asset.id,
                              qr_code: qrCode,
                              file_name:
                                storedFileName,
                              title,
                              document_type:
                                documentType,
                              description:
                                description || null
                            }
                          })
                        }
                      )
                    }
                  )
                }
              )
            }
          )
        }
      )

       /*
       * List documents attached to an asset.
       */
      router.access('readonly').get(
        '/asset/:qrCode/documents',
        (req: any, res: any) => {
          const qrCode = req.params.qrCode
          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'
          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the asset database'
                })
                return
              }

              const sql = `
                SELECT
                  d.id,
                  d.title,
                  d.document_type,
                  d.file_name,
                  d.description
                FROM asset_documents d
                JOIN assets a
                  ON d.asset_id = a.id
                WHERE a.qr_code = ?
                ORDER BY d.title
              `

              db.all(
                sql,
                [qrCode],
                (queryErr: Error | null, documents: any[]) => {
                  db.close()

                  if (queryErr) {
                    res.status(500).json({
                      ok: false,
                      error: 'Document lookup failed'
                    })
                    return
                  }

                  res.status(200).json({
                    ok: true,
                    qrCode,
                    documents
                  })
                }
              )
            }
          )
        }
      )

      /*
       * Open or download one document belonging to an asset.
       */
      router.access('readonly').get(
        '/asset/:qrCode/document/:documentId',
        (req: any, res: any) => {
          const qrCode = req.params.qrCode
          const documentId =
            Number.parseInt(req.params.documentId, 10)

          if (!Number.isInteger(documentId)) {
            res.status(400).send('Invalid document number')
            return
          }

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'
          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).send(
                  'Unable to open the asset database'
                )
                return
              }

              const sql = `
                SELECT
                  d.file_name,
                  d.file_path
                FROM asset_documents d
                JOIN assets a
                  ON d.asset_id = a.id
                WHERE a.qr_code = ?
                  AND d.id = ?
              `

              db.get(
                sql,
                [qrCode, documentId],
                (queryErr: Error | null, document: any) => {
                  db.close()

                  if (queryErr) {
                    res.status(500).send(
                      'Document lookup failed'
                    )
                    return
                  }

                  if (!document) {
                    res.status(404).send(
                      'Document not found'
                    )
                    return
                  }

                  const documentRoot = path.resolve(
                    dataDir,
                    'storage',
                    'documents'
                  )

                  const resolvedFile =
                    path.resolve(document.file_path)

                  if (
                    !resolvedFile.startsWith(
                      documentRoot + path.sep
                    )
                  ) {
                    res.status(403).send(
                      'Document path is not permitted'
                    )
                    return
                  }

                  if (!fs.existsSync(resolvedFile)) {
                    res.status(404).send(
                      'Document file is missing'
                    )
                    return
                  }

                  res.sendFile(resolvedFile)
                }
              )
            }
          )
        }
      )

      /*
       * List maintenance requests for an asset.
       */
      router.access('readonly').get(
        '/asset/:qrCode/maintenance-requests',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '').trim()

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'
          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the equipment database'
                })
                return
              }

              db.get(
                'SELECT id FROM assets WHERE qr_code = ?',
                [qrCode],
                (
                  assetErr: Error | null,
                  asset: { id: number } | undefined
                ) => {
                  if (assetErr || !asset) {
                    res.status(assetErr ? 500 : 404).json({
                      ok: false,
                      error: assetErr
                        ? 'Unable to find the equipment'
                        : 'Equipment not found'
                    })
                    db.close()
                    return
                  }

                  db.all(
                    `
                    SELECT
                      id,
                      asset_id,
                      request_number,
                      title,
                      description,
                      priority,
                      status,
                      reported_date,
                      reported_by,
                      assigned_to,
                      target_date,
                      closed_date,
                      resolution_notes,
                      created_at,
                      updated_at
                    FROM maintenance_requests
                    WHERE asset_id = ?
                    ORDER BY
                      CASE priority
                        WHEN 'Critical' THEN 1
                        WHEN 'High' THEN 2
                        WHEN 'Normal' THEN 3
                        WHEN 'Low' THEN 4
                        ELSE 5
                      END,
                      created_at DESC,
                      id DESC
                    `,
                    [asset.id],
                    (err: Error | null, requests: any[]) => {
                      if (err) {
                        res.status(500).json({
                          ok: false,
                          error: 'Unable to load maintenance requests'
                        })
                      } else {
                        res.status(200).json({
                          ok: true,
                          asset_id: asset.id,
                          requests
                        })
                      }

                      db.close()
                    }
                  )
                }
              )
            }
          )
        }
      )

      /*
       * Open a maintenance request for an asset.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/maintenance-requests',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '').trim()
          const title =
            typeof req.body?.title === 'string'
              ? req.body.title.trim()
              : ''
          const description =
            typeof req.body?.description === 'string'
              ? req.body.description.trim()
              : ''
          const priority =
            typeof req.body?.priority === 'string'
              ? req.body.priority.trim()
              : 'Normal'
          const reportedBy =
            typeof req.body?.reported_by === 'string'
              ? req.body.reported_by.trim()
              : ''
          const assignedTo =
            typeof req.body?.assigned_to === 'string'
              ? req.body.assigned_to.trim()
              : ''
          const targetDate =
            typeof req.body?.target_date === 'string'
              ? req.body.target_date.trim()
              : ''

          if (!title) {
            res.status(400).json({
              ok: false,
              error: 'Maintenance request title is required'
            })
            return
          }

          if (
            !['Low', 'Normal', 'High', 'Critical'].includes(priority)
          ) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance priority'
            })
            return
          }

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'
          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READWRITE,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the equipment database'
                })
                return
              }

              db.get(
                'SELECT id FROM assets WHERE qr_code = ?',
                [qrCode],
                (
                  assetErr: Error | null,
                  asset: { id: number } | undefined
                ) => {
                  if (assetErr || !asset) {
                    res.status(assetErr ? 500 : 404).json({
                      ok: false,
                      error: assetErr
                        ? 'Unable to find the equipment'
                        : 'Equipment not found'
                    })
                    db.close()
                    return
                  }

                  db.run(
                    `
                    INSERT INTO maintenance_requests (
                      asset_id,
                      title,
                      description,
                      priority,
                      status,
                      reported_by,
                      assigned_to,
                      target_date
                    )
                    VALUES (?, ?, ?, ?, 'Open', ?, ?, ?)
                    `,
                    [
                      asset.id,
                      title,
                      description || null,
                      priority,
                      reportedBy || null,
                      assignedTo || null,
                      targetDate || null
                    ],
                    function (
                      this: any,
                      insertErr: Error | null
                    ) {
                      if (insertErr) {
                        res.status(500).json({
                          ok: false,
                          error: 'Unable to save maintenance request'
                        })
                        db.close()
                        return
                      }

                      const requestId = this.lastID
                      const requestNumber =
                        `MR-${String(requestId).padStart(6, '0')}`

                      db.run(
                        `
                        UPDATE maintenance_requests
                        SET request_number = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        `,
                        [requestNumber, requestId],
                        (updateErr: Error | null) => {
                          if (updateErr) {
                            res.status(500).json({
                              ok: false,
                              error:
                                'Unable to assign maintenance request number'
                            })
                          } else {
                            res.status(201).json({
                              ok: true,
                              request: {
                                id: requestId,
                                request_number: requestNumber,
                                asset_id: asset.id,
                                title,
                                description: description || null,
                                priority,
                                status: 'Open'
                              }
                            })
                          }

                          db.close()
                        }
                      )
                    }
                  )
                }
              )
            }
          )
        }
      )

      /*
       * Edit, close, or cancel a maintenance request.
       */
      router.access('readwrite').patch(
        '/asset/:qrCode/maintenance-requests/:requestId',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '').trim()

          const requestId = Number.parseInt(
            String(req.params.requestId || ''),
            10
          )

          if (!qrCode || !Number.isInteger(requestId) || requestId < 1) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance request'
            })
            return
          }

          const title =
            typeof req.body?.title === 'string'
              ? req.body.title.trim()
              : ''

          const description =
            typeof req.body?.description === 'string'
              ? req.body.description.trim()
              : ''

          const priority =
            typeof req.body?.priority === 'string'
              ? req.body.priority.trim()
              : 'Normal'

          const status =
            typeof req.body?.status === 'string'
              ? req.body.status.trim()
              : 'Open'

          const reportedBy =
            typeof req.body?.reported_by === 'string'
              ? req.body.reported_by.trim()
              : ''

          const assignedTo =
            typeof req.body?.assigned_to === 'string'
              ? req.body.assigned_to.trim()
              : ''

          const targetDate =
            typeof req.body?.target_date === 'string'
              ? req.body.target_date.trim()
              : ''

          const closedDate =
            typeof req.body?.closed_date === 'string'
              ? req.body.closed_date.trim()
              : ''

          const resolutionNotes =
            typeof req.body?.resolution_notes === 'string'
              ? req.body.resolution_notes.trim()
              : ''

          const validPriorities = [
            'Low',
            'Normal',
            'High',
            'Critical'
          ]

          const validStatuses = [
            'Open',
            'Closed',
            'Cancelled'
          ]

          if (!title || title.length > 200) {
            res.status(400).json({
              ok: false,
              error: 'Maintenance request title is required'
            })
            return
          }

          if (!validPriorities.includes(priority)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance priority'
            })
            return
          }

          if (!validStatuses.includes(status)) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance request status'
            })
            return
          }

          if (
            targetDate &&
            !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)
          ) {
            res.status(400).json({
              ok: false,
              error: 'Target date must use YYYY-MM-DD'
            })
            return
          }

          if (
            closedDate &&
            !/^\d{4}-\d{2}-\d{2}$/.test(closedDate)
          ) {
            res.status(400).json({
              ok: false,
              error: 'Closed date must use YYYY-MM-DD'
            })
            return
          }

          if (
            status === 'Closed' &&
            !resolutionNotes
          ) {
            res.status(400).json({
              ok: false,
              error: 'Resolution notes are required when closing a request'
            })
            return
          }

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'
          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READWRITE,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the equipment database'
                })
                return
              }

              db.get(
                `
                SELECT
                  r.id,
                  r.request_number
                FROM maintenance_requests r
                JOIN assets a
                  ON a.id = r.asset_id
                WHERE r.id = ?
                  AND a.qr_code = ?
                `,
                [requestId, qrCode],
                (
                  findErr: Error | null,
                  request:
                    | {
                        id: number
                        request_number: string
                      }
                    | undefined
                ) => {
                  if (findErr) {
                    res.status(500).json({
                      ok: false,
                      error: 'Unable to read maintenance request'
                    })
                    db.close()
                    return
                  }

                  if (!request) {
                    res.status(404).json({
                      ok: false,
                      error: 'Maintenance request not found'
                    })
                    db.close()
                    return
                  }

                  const effectiveClosedDate =
                    status === 'Closed'
                      ? (
                          closedDate ||
                          new Date()
                            .toISOString()
                            .slice(0, 10)
                        )
                      : null

                  db.run(
                    `
                    UPDATE maintenance_requests
                       SET title = ?,
                           description = NULLIF(?, ''),
                           priority = ?,
                           status = ?,
                           reported_by = NULLIF(?, ''),
                           assigned_to = NULLIF(?, ''),
                           target_date = NULLIF(?, ''),
                           closed_date = ?,
                           resolution_notes = NULLIF(?, ''),
                           updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?
                    `,
                    [
                      title,
                      description,
                      priority,
                      status,
                      reportedBy,
                      assignedTo,
                      targetDate,
                      effectiveClosedDate,
                      resolutionNotes,
                      requestId
                    ],
                    (updateErr: Error | null) => {
                      if (updateErr) {
                        app.error(
                          `Maintenance request update failed: ${updateErr.message}`
                        )

                        res.status(500).json({
                          ok: false,
                          error: 'Unable to update maintenance request'
                        })

                        db.close()
                        return
                      }

                      res.status(200).json({
                        ok: true,
                        request: {
                          id: requestId,
                          request_number:
                            request.request_number,
                          title,
                          description:
                            description || null,
                          priority,
                          status,
                          reported_by:
                            reportedBy || null,
                          assigned_to:
                            assignedTo || null,
                          target_date:
                            targetDate || null,
                          closed_date:
                            effectiveClosedDate,
                          resolution_notes:
                            resolutionNotes || null
                        }
                      })

                      db.close()
                    }
                  )
                }
              )
            }
          )
        }
      )

      /*
       * List active maintenance schedules for an asset.
       */
      router.access('readonly').get(
        '/asset/:qrCode/maintenance-schedules',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the asset database'
                })

                return
              }

              const sql = `
                SELECT
                  s.id,
                  s.asset_id,
                  s.document_id,
                  s.task_name,
                  s.service_type,
                  s.instructions,
                  s.document_page,
                  s.interval_months,
                  s.interval_hours,
                  s.warning_days,
                  s.warning_hours,
                  s.last_completed_date,
                  s.last_completed_hours,
                  s.next_due_date,
                  s.next_due_hours,
                  s.active,
                  a.operating_hours,
                  a.operating_hours_updated_at,
                  d.title AS document_title
                FROM maintenance_schedules s
                JOIN assets a
                  ON s.asset_id = a.id
                LEFT JOIN asset_documents d
                  ON s.document_id = d.id
                WHERE a.qr_code = ?
                  AND s.active = 1
                ORDER BY s.task_name
              `

              db.all(
                sql,
                [qrCode],
                (
                  queryErr: Error | null,
                  schedules: any[]
                ) => {
                  db.close()

                  if (queryErr) {
                    app.error(
                      'Maintenance schedule lookup failed: ' +
                      queryErr.message
                    )

                    res.status(500).json({
                      ok: false,
                      error:
                        'Maintenance schedule lookup failed'
                    })

                    return
                  }

                  res.status(200).json({
                    ok: true,
                    qrCode,
                    schedules
                  })
                }
              )
            }
          )
        }
      )

      /*
       * Update the manually entered operating-hours reading.
       *
       * Requires authenticated Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/operating-hours',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          let rawBody = ''
          let requestTooLarge = false

          req.setEncoding('utf8')

          req.on('data', (chunk: string) => {
            rawBody += chunk

            if (rawBody.length > 16 * 1024) {
              requestTooLarge = true
            }
          })

          req.on('end', () => {
            if (requestTooLarge) {
              res.status(413).json({
                ok: false,
                error: 'Request body is too large'
              })

              return
            }

            let submitted: any

            try {
              submitted = JSON.parse(rawBody || '{}')
            } catch {
              res.status(400).json({
                ok: false,
                error: 'Invalid JSON request'
              })

              return
            }

            if (
              submitted.operating_hours === null ||
              submitted.operating_hours === undefined ||
              submitted.operating_hours === ''
            ) {
              res.status(400).json({
                ok: false,
                error: 'Operating hours are required'
              })

              return
            }

            const operatingHours =
              Number(submitted.operating_hours)

            if (
              !Number.isFinite(operatingHours) ||
              operatingHours < 0
            ) {
              res.status(400).json({
                ok: false,
                error:
                  'Operating hours must be zero or greater'
              })

              return
            }

            const databaseFile =
              currentSettings.databaseFile ||
              'quartermaster.db'

            const dbPath = path.join(
              dataDir,
              databaseFile
            )

            const db = new sqlite3.Database(
              dbPath,
              sqlite3.OPEN_READWRITE,
              (openErr: Error | null) => {
                if (openErr) {
                  res.status(500).json({
                    ok: false,
                    error:
                      'Unable to open the asset database'
                  })

                  return
                }

                const sql = `
                  UPDATE assets
                  SET
                    operating_hours = ?,
                    operating_hours_updated_at =
                      CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                  WHERE qr_code = ?
                `

                db.run(
                  sql,
                  [operatingHours, qrCode],
                  function (this: any, updateErr: Error | null) {
                    if (updateErr) {
                      app.error(
                        'Operating-hours update failed: ' +
                        updateErr.message
                      )

                      res.status(500).json({
                        ok: false,
                        error:
                          'Unable to update operating hours'
                      })

                      db.close()
                      return
                    }

                    if (this.changes === 0) {
                      res.status(404).json({
                        ok: false,
                        error: 'Asset not found'
                      })

                      db.close()
                      return
                    }

                    res.status(200).json({
                      ok: true,
                      qrCode,
                      operating_hours: operatingHours
                    })

                    db.close()
                  }
                )
              }
            )
          })

          req.on('error', () => {
            res.status(400).json({
              ok: false,
              error: 'Unable to read request'
            })
          })
        }
      )

      /*
       * Establish the last-completed baseline for a schedule.
       *
       * Requires authenticated Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/maintenance-schedules/' +
        ':scheduleId/baseline',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          const scheduleId = Number.parseInt(
            String(req.params.scheduleId || ''),
            10
          )

          if (!Number.isInteger(scheduleId) || scheduleId < 1) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance schedule number'
            })

            return
          }

          let rawBody = ''
          let requestTooLarge = false

          req.setEncoding('utf8')

          req.on('data', (chunk: string) => {
            rawBody += chunk

            if (rawBody.length > 8192) {
              requestTooLarge = true
            }
          })

          req.on('end', () => {
            if (requestTooLarge) {
              res.status(413).json({
                ok: false,
                error: 'Baseline request is too large'
              })

              return
            }

            let submitted: any = {}

            try {
              submitted = JSON.parse(rawBody || '{}')
            } catch {
              res.status(400).json({
                ok: false,
                error: 'Invalid baseline data'
              })

              return
            }

            const dateValue =
              submitted.last_completed_date === null ||
              submitted.last_completed_date === undefined
                ? ''
                : String(
                    submitted.last_completed_date
                  ).trim()

            let completedDate: string | null = null

            if (dateValue !== '') {
              if (
                !/^\d{4}-\d{2}-\d{2}$/.test(dateValue) ||
                Number.isNaN(
                  Date.parse(dateValue + 'T00:00:00Z')
                )
              ) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Last service date must use YYYY-MM-DD'
                })

                return
              }

              completedDate = dateValue
            }

            const hoursValue =
              submitted.last_completed_hours

            let completedHours: number | null = null

            if (
              hoursValue !== null &&
              hoursValue !== undefined &&
              String(hoursValue).trim() !== ''
            ) {
              completedHours = Number(hoursValue)

              if (
                !Number.isFinite(completedHours) ||
                completedHours < 0
              ) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Engine hours must be zero or greater'
                })

                return
              }
            }

            if (
              completedDate === null &&
              completedHours === null
            ) {
              res.status(400).json({
                ok: false,
                error:
                  'Enter a last service date, engine hours, ' +
                  'or both'
              })

              return
            }

            const databaseFile =
              currentSettings.databaseFile ||
              'quartermaster.db'

            const dbPath = path.join(
              dataDir,
              databaseFile
            )

            const db = new sqlite3.Database(
              dbPath,
              sqlite3.OPEN_READWRITE,
              (openErr: Error | null) => {
                if (openErr) {
                  res.status(500).json({
                    ok: false,
                    error:
                      'Unable to open the asset database'
                  })

                  return
                }

                const updateSql = `
                  UPDATE maintenance_schedules
                  SET
                    last_completed_date = ?,
                    last_completed_hours = ?,

                    next_due_date =
                      CASE
                        WHEN ? IS NOT NULL
                          AND interval_months IS NOT NULL
                        THEN date(
                          ?,
                          '+' || interval_months || ' months'
                        )
                        ELSE NULL
                      END,

                    next_due_hours =
                      CASE
                        WHEN ? IS NOT NULL
                          AND interval_hours IS NOT NULL
                        THEN ? + interval_hours
                        ELSE NULL
                      END,

                    updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
                    AND active = 1
                    AND asset_id = (
                      SELECT id
                      FROM assets
                      WHERE qr_code = ?
                    )
                `

                db.run(
                  updateSql,
                  [
                    completedDate,
                    completedHours,
                    completedDate,
                    completedDate,
                    completedHours,
                    completedHours,
                    scheduleId,
                    qrCode
                  ],
                  function (
                    this: { changes: number },
                    updateErr: Error | null
                  ) {
                    if (updateErr) {
                      app.error(
                        'Maintenance baseline update failed: ' +
                        updateErr.message
                      )

                      db.close()

                      res.status(500).json({
                        ok: false,
                        error:
                          'Unable to save the maintenance baseline'
                      })

                      return
                    }

                    if (this.changes !== 1) {
                      db.close()

                      res.status(404).json({
                        ok: false,
                        error:
                          'Maintenance schedule not found'
                      })

                      return
                    }

                    db.get(
                      `
                        SELECT
                          id,
                          task_name,
                          last_completed_date,
                          last_completed_hours,
                          next_due_date,
                          next_due_hours
                        FROM maintenance_schedules
                        WHERE id = ?
                      `,
                      [scheduleId],
                      (
                        queryErr: Error | null,
                        schedule: any
                      ) => {
                        db.close()

                        if (queryErr) {
                          res.status(500).json({
                            ok: false,
                            error:
                              'Unable to read the updated schedule'
                          })

                          return
                        }

                        res.status(200).json({
                          ok: true,
                          schedule
                        })
                      }
                    )
                  }
                )
              }
            )
          })
        }
      )

      /*
       * List completed maintenance records for an asset.
       */
      router.access('readonly').get(
        '/asset/:qrCode/maintenance-records',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                res.status(500).json({
                  ok: false,
                  error: 'Unable to open the asset database'
                })

                return
              }

              const sql = `
                SELECT
                  m.id,
                  m.schedule_id,
                  m.service_date,
                  m.service_type,
                  m.description,
                  m.performed_by,
                  m.cost,
                  m.engine_hours,
                  m.next_service_date,
                  m.next_service_hours,
                  m.created_at,
                  s.task_name
                FROM maintenance_records m
                JOIN assets a
                  ON m.asset_id = a.id
                LEFT JOIN maintenance_schedules s
                  ON m.schedule_id = s.id
                WHERE a.qr_code = ?
                ORDER BY
                  m.service_date DESC,
                  m.id DESC
              `

              db.all(
                sql,
                [qrCode],
                (
                  queryErr: Error | null,
                  records: any[]
                ) => {
                  db.close()

                  if (queryErr) {
                    app.error(
                      'Maintenance history lookup failed: ' +
                      queryErr.message
                    )

                    res.status(500).json({
                      ok: false,
                      error:
                        'Maintenance history lookup failed'
                    })

                    return
                  }

                  res.status(200).json({
                    ok: true,
                    qrCode,
                    records
                  })
                }
              )
            }
          )
        }
      )

      /*
       * Record completed maintenance and advance its schedule.
       *
       * Requires authenticated Signal K read-write access.
       */
      router.access('readwrite').post(
        '/asset/:qrCode/maintenance-schedules/' +
        ':scheduleId/complete',
        (req: any, res: any) => {
          const qrCode = String(req.params.qrCode || '')

          const scheduleId = Number.parseInt(
            String(req.params.scheduleId || ''),
            10
          )

          if (!Number.isInteger(scheduleId) || scheduleId < 1) {
            res.status(400).json({
              ok: false,
              error: 'Invalid maintenance schedule number'
            })
            return
          }

          let rawBody = ''
          let requestTooLarge = false

          req.setEncoding('utf8')

          req.on('data', (chunk: string) => {
            rawBody += chunk

            if (rawBody.length > 32768) {
              requestTooLarge = true
            }
          })

          req.on('end', () => {
            if (requestTooLarge) {
              res.status(413).json({
                ok: false,
                error: 'Maintenance request is too large'
              })
              return
            }

            let submitted: any = {}

            try {
              submitted = JSON.parse(rawBody || '{}')
            } catch {
              res.status(400).json({
                ok: false,
                error: 'Invalid maintenance data'
              })
              return
            }

            const cleanText = (
              input: any,
              maximumLength: number
            ) => {
              if (
                input === null ||
                input === undefined
              ) {
                return null
              }

              const cleaned = String(input).trim()

              return cleaned === ''
                ? null
                : cleaned.slice(0, maximumLength)
            }

            const serviceDate = cleanText(
              submitted.service_date,
              10
            )

            if (!serviceDate) {
              res.status(400).json({
                ok: false,
                error: 'Service date is required'
              })
              return
            }

            const parsedDate = new Date(
              serviceDate + 'T00:00:00Z'
            )

            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
              Number.isNaN(parsedDate.getTime()) ||
              parsedDate.toISOString().slice(0, 10) !==
                serviceDate
            ) {
              res.status(400).json({
                ok: false,
                error: 'Service date must use YYYY-MM-DD'
              })
              return
            }

            const description = cleanText(
              submitted.description,
              4000
            )

            if (!description) {
              res.status(400).json({
                ok: false,
                error: 'Work performed is required'
              })
              return
            }

            const submittedHours =
              submitted.engine_hours

            let engineHours: number | null = null

            if (
              submittedHours !== null &&
              submittedHours !== undefined &&
              String(submittedHours).trim() !== ''
            ) {
              engineHours = Number(submittedHours)

              if (
                !Number.isFinite(engineHours) ||
                engineHours < 0
              ) {
                res.status(400).json({
                  ok: false,
                  error:
                    'Engine hours must be zero or greater'
                })
                return
              }
            }

            const submittedCost = submitted.cost
            let cost: number | null = null

            if (
              submittedCost !== null &&
              submittedCost !== undefined &&
              String(submittedCost).trim() !== ''
            ) {
              cost = Number(submittedCost)

              if (!Number.isFinite(cost) || cost < 0) {
                res.status(400).json({
                  ok: false,
                  error: 'Cost must be zero or greater'
                })
                return
              }
            }

            const performedBy =
              cleanText(submitted.performed_by, 150) ||
              cleanText(
                req.user?.username || req.user?.name,
                150
              ) ||
              'Signal K user'

            const databaseFile =
              currentSettings.databaseFile ||
              'quartermaster.db'

            const dbPath = path.join(
              dataDir,
              databaseFile
            )

            const db = new sqlite3.Database(
              dbPath,
              sqlite3.OPEN_READWRITE,
              (openErr: Error | null) => {
                if (openErr) {
                  res.status(500).json({
                    ok: false,
                    error:
                      'Unable to open the asset database'
                  })
                  return
                }

                let transactionStarted = false

                const fail = (
                  status: number,
                  publicMessage: string,
                  logMessage?: string
                ) => {
                  if (logMessage) {
                    app.error(logMessage)
                  }

                  const finish = () => {
                    db.close()
                    res.status(status).json({
                      ok: false,
                      error: publicMessage
                    })
                  }

                  if (transactionStarted) {
                    db.run('ROLLBACK', () => finish())
                  } else {
                    finish()
                  }
                }

                db.run(
                  'PRAGMA foreign_keys = ON',
                  (pragmaErr: Error | null) => {
                    if (pragmaErr) {
                      fail(
                        500,
                        'Unable to prepare the database',
                        pragmaErr.message
                      )
                      return
                    }

                    db.run(
                      'BEGIN IMMEDIATE TRANSACTION',
                      (beginErr: Error | null) => {
                        if (beginErr) {
                          fail(
                            500,
                            'Unable to begin maintenance record',
                            beginErr.message
                          )
                          return
                        }

                        transactionStarted = true

                        const scheduleSql = `
                          SELECT
                            s.asset_id,
                            s.task_name,
                            s.service_type,

                            CASE
                              WHEN s.interval_months IS NOT NULL
                              THEN date(
                                ?,
                                '+' || s.interval_months ||
                                ' months'
                              )
                              ELSE NULL
                            END AS next_due_date,

                            CASE
                              WHEN ? IS NOT NULL
                                AND s.interval_hours IS NOT NULL
                              THEN ? + s.interval_hours
                              ELSE NULL
                            END AS next_due_hours
                          FROM maintenance_schedules s
                          JOIN assets a
                            ON s.asset_id = a.id
                          WHERE s.id = ?
                            AND a.qr_code = ?
                            AND s.active = 1
                        `

                        db.get(
                          scheduleSql,
                          [
                            serviceDate,
                            engineHours,
                            engineHours,
                            scheduleId,
                            qrCode
                          ],
                          (
                            scheduleErr: Error | null,
                            schedule: any
                          ) => {
                            if (scheduleErr) {
                              fail(
                                500,
                                'Unable to read the schedule',
                                scheduleErr.message
                              )
                              return
                            }

                            if (!schedule) {
                              fail(
                                404,
                                'Maintenance schedule not found'
                              )
                              return
                            }

                            const insertSql = `
                              INSERT INTO maintenance_records (
                                asset_id,
                                schedule_id,
                                service_date,
                                service_type,
                                description,
                                performed_by,
                                cost,
                                engine_hours,
                                next_service_date,
                                next_service_hours
                              )
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `

                            db.run(
                              insertSql,
                              [
                                schedule.asset_id,
                                scheduleId,
                                serviceDate,
                                schedule.service_type,
                                description,
                                performedBy,
                                cost,
                                engineHours,
                                schedule.next_due_date,
                                schedule.next_due_hours
                              ],
                              function (
                                this: { lastID: number },
                                insertErr: Error | null
                              ) {
                                if (insertErr) {
                                  fail(
                                    500,
                                    'Unable to save maintenance',
                                    insertErr.message
                                  )
                                  return
                                }

                                const recordId = this.lastID

                                const updateSql = `
                                  UPDATE maintenance_schedules
                                  SET
                                    last_completed_date = ?,
                                    last_completed_hours = ?,
                                    next_due_date = ?,
                                    next_due_hours = ?,
                                    updated_at =
                                      CURRENT_TIMESTAMP
                                  WHERE id = ?
                                    AND active = 1
                                `

                                db.run(
                                  updateSql,
                                  [
                                    serviceDate,
                                    engineHours,
                                    schedule.next_due_date,
                                    schedule.next_due_hours,
                                    scheduleId
                                  ],
                                  function (
                                    this: { changes: number },
                                    updateErr: Error | null
                                  ) {
                                    if (
                                      updateErr ||
                                      this.changes !== 1
                                    ) {
                                      fail(
                                        500,
                                        'Unable to advance schedule',
                                        updateErr?.message
                                      )
                                      return
                                    }

                                    db.run(
                                      'COMMIT',
                                      (
                                        commitErr:
                                          Error | null
                                      ) => {
                                        if (commitErr) {
                                          fail(
                                            500,
                                            'Unable to complete maintenance',
                                            commitErr.message
                                          )
                                          return
                                        }

                                        transactionStarted = false
                                        db.close()

                                        res.status(201).json({
                                          ok: true,
                                          record: {
                                            id: recordId,
                                            schedule_id:
                                              scheduleId,
                                            service_date:
                                              serviceDate,
                                            engine_hours:
                                              engineHours,
                                            next_service_date:
                                              schedule.next_due_date,
                                            next_service_hours:
                                              schedule.next_due_hours
                                          }
                                        })
                                      }
                                    )
                                  }
                                )
                              }
                            )
                          }
                        )
                      }
                    )
                  }
                )
              }
            )
          })
        }
      )

      /*
       * Quartermaster human-readable asset page
       *
       * This is the page opened by a QR scan.
       *
       * Example:
       * /asset/QM-ASSET-0001
       */
      router.access('readonly').get(
        '/asset/:qrCode',
        (req: any, res: any) => {
          const qrCode = req.params.qrCode

          const databaseFile =
            currentSettings.databaseFile || 'quartermaster.db'

          const dbPath = path.join(dataDir, databaseFile)

          app.debug(`Asset page requested: ${qrCode}`)
          app.debug(`Quartermaster database: ${dbPath}`)

          const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READONLY,
            (openErr: Error | null) => {
              if (openErr) {
                app.error(
                  `Unable to open Quartermaster database: ${openErr.message}`
                )

                res.status(500).send(`
                  <!DOCTYPE html>
                  <html>
                    <head>
                      <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1"
                      >
                      <title>Quartermaster</title>
                    </head>
                    <body>
                      <h1>Quartermaster</h1>
                      <p>Unable to open the asset database.</p>
                    </body>
                  </html>
                `)

                return
              }

              const sql = `
                SELECT
                  a.id,
                  a.asset_uuid,
                  a.name,
                  a.category,
                  a.manufacturer,
                  a.model,
                  a.serial_number,
                  a.location,
                  a.description,
                  a.status,
                  a.qr_code,
                  v.id AS vessel_id,
                  v.name AS vessel_name
                FROM assets a
                JOIN vessels v
                  ON a.vessel_id = v.id
                WHERE a.qr_code = ?
              `

              db.get(
                sql,
                [qrCode],
                (queryErr: Error | null, asset: any) => {
                  if (queryErr) {
                    app.error(
                      `Quartermaster asset page lookup failed: ${queryErr.message}`
                    )

                    res.status(500).send(`
                      <!DOCTYPE html>
                      <html>
                        <head>
                          <meta
                            name="viewport"
                            content="width=device-width, initial-scale=1"
                          >
                          <title>Quartermaster</title>
                        </head>
                        <body>
                          <h1>Quartermaster</h1>
                          <p>Database query failed.</p>
                        </body>
                      </html>
                    `)

                    db.close()
                    return
                  }

                  if (!asset) {
                    res.status(404).send(`
                      <!DOCTYPE html>
                      <html lang="en">
                        <head>
                          <meta charset="UTF-8">

                          <meta
                            name="viewport"
                            content="width=device-width, initial-scale=1"
                          >

                          <title>Asset Not Found</title>
                        </head>

                        <body>
                          <h1>Quartermaster</h1>
                          <h2>Asset Not Found</h2>

                          <p>
                            No asset was found for QR code
                            ${qrCode}.
                          </p>
                        </body>
                      </html>
                    `)

                    db.close()
                    return
                  }

                  /*
                   * Escape database values before inserting
                   * them into HTML.
                   */
                  const value = (input: any) => {
                    if (
                      input === null ||
                      input === undefined ||
                      input === ''
                    ) {
                      return '—'
                    }

                    return String(input)
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&#039;')
                  }

                  res.status(200).send(`
                    <!DOCTYPE html>
                    <html lang="en">

                    <head>
                      <meta charset="UTF-8">

                      <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1"
                      >

                      <title>
                        ${value(asset.name)} | Quartermaster
                      </title>

                      <style>
                        * {
                          box-sizing: border-box;
                        }

                        body {
                          margin: 0;
                          background: #f4f6f8;
                          font-family:
                            Arial,
                            Helvetica,
                            sans-serif;
                          color: #1f2933;
                        }

                        header {
                          background: #17324d;
                          color: white;
                          padding: 22px 20px;
                        }

                        header h1 {
                          margin: 0;
                          font-size: 26px;
                        }

                        header p {
                          margin: 5px 0 0 0;
                          color: #d8e2ea;
                        }

                        main {
                          max-width: 760px;
                          margin: auto;
                          padding: 20px;
                        }

                        .card {
                          background: white;
                          border-radius: 10px;
                          padding: 22px;
                          box-shadow:
                            0 2px 8px rgba(0, 0, 0, 0.08);
                        }

                        .asset-name {
                          margin-top: 0;
                          margin-bottom: 5px;
                          font-size: 28px;
                        }

                        .qr {
                          color: #61707d;
                          margin-bottom: 22px;
                        }

                         .print-actions {
                          margin: 0 0 24px 0;
                        }

                        .print-button {
                          border: 0;
                          border-radius: 7px;
                          background: #17324d;
                          color: white;
                          padding: 12px 18px;
                          font-size: 16px;
                          font-weight: bold;
                          cursor: pointer;
                        }     
                         .print-button:disabled {
                          background: #8896a3;
                          cursor: wait;
                        }

                        .print-message {
                          min-height: 22px;
                          margin-top: 10px;
                          color: #334e68;
                        }

                        .print-error {
                          color: #a61b1b;
                        }

                        
                        .row {
                          border-top:
                            1px solid #e4e8eb;
                          padding: 12px 0;
                        }

                        .label {
                          display: block;
                          font-size: 12px;
                          font-weight: bold;
                          color: #667784;
                          text-transform: uppercase;
                          margin-bottom: 4px;
                        }

                        .value {
                          font-size: 17px;
                        }

                        .description {
                          line-height: 1.5;
                        }

                        .section {
                          margin-top: 22px;
                        }

                        .section h3 {
                          border-bottom:
                            2px solid #17324d;
                          padding-bottom: 7px;
                        }

                        .maintenance-card {
                          border: 1px solid #d7dee3;
                          border-radius: 8px;
                          margin-top: 14px;
                          padding: 16px;
                          background: #f8fafb;
                        }

                        .maintenance-heading {
                          display: flex;
                          align-items: center;
                          justify-content: space-between;
                          gap: 12px;
                          flex-wrap: wrap;
                          margin-bottom: 12px;
                        }

                        .maintenance-heading h4 {
                          margin: 0;
                          font-size: 18px;
                        }

                        .maintenance-status {
                          display: inline-block;
                          border-radius: 14px;
                          padding: 5px 10px;
                          font-size: 13px;
                          font-weight: bold;
                        }

                        .status-baseline {
                          background: #e8edf1;
                          color: #465866;
                        }

                        .status-current {
                          background: #dff3e5;
                          color: #176b36;
                        }

                        .status-due-soon {
                          background: #fff1bf;
                          color: #765600;
                        }

                        .status-overdue {
                          background: #f9d6d5;
                          color: #9b1c1c;
                        }

                        .maintenance-detail {
                          margin: 7px 0;
                          line-height: 1.4;
                        }

                        .maintenance-detail strong {
                          color: #465866;
                        }

                        .future {
                          color: #77838d;
                          font-style: italic;
                        }

                        footer {
                          text-align: center;
                          color: #77838d;
                          font-size: 13px;
                          padding: 25px;
                        }
                      </style>
                    </head>

                    <body>

                      <header>
                        <h1>Quartermaster</h1>
                        <p>
                          ${value(asset.vessel_name)}
                        </p>
                      </header>

                      <main>

                        <p><a href="/plugins/signalk-quartermaster/home">
                          ← Quartermaster home
                        </a></p>

                        <div class="card">

                          <h2 class="asset-name">
                            ${value(asset.name)}
                          </h2>

                          <div class="qr">
                            ${value(asset.qr_code)}
                          </div>

                          <div class="print-actions">
                            <button
                              type="button"
                              id="print-label-button"
                              class="print-button"
                              onclick="printAssetLabel()"
                            >
                              Print 3 × 5 Label
                            </button>

                            <div
                              id="print-label-message"
                              class="print-message"
                            ></div>
                          </div>

                          <div class="row">
                            <span class="label">
                              Category
                            </span>

                            <span class="value">
                              ${value(asset.category)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Manufacturer
                            </span>

                            <span class="value">
                              ${value(asset.manufacturer)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Model
                            </span>

                            <span class="value">
                              ${value(asset.model)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Serial Number
                            </span>

                            <span class="value">
                              ${value(asset.serial_number)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Location
                            </span>

                            <span class="value">
                              ${value(asset.location)}
                            </span>
                          </div>

                          <div class="row">
                            <span class="label">
                              Status
                            </span>

                            <span class="value">
                              ${value(asset.status)}
                            </span>
                          </div>

                          <div class="row description">
                            <span class="label">
                              Description
                            </span>

                            <span class="value">
                              ${value(asset.description)}
                            </span>
                          </div>

                          <div class="section">
                            <h3>Parts</h3>

                            <p class="future">
                              Replacement and service
                              parts will appear here.
                            </p>
                          </div>

                          <div class="section">
                            <h3>Documents</h3>

                            <div id="documents-list">
                              <p class="future">
                                Loading documents...
                              </p>
                            </div>
                                                      <div
                              style="
                                margin-top: 24px;
                                padding-top: 18px;
                                border-top: 1px solid #e4e8eb;
                              "
                            >
                              <h4>Add Document</h4>

                              <p class="future">
                                Signal K login with read-write
                                permission is required.
                              </p>

                              <form
                                id="document-upload-form"
                                enctype="multipart/form-data"
                              >
                                <p>
                                  <label for="document-title">
                                    Document title
                                  </label>
                                  <br>
                                  <input
                                    id="document-title"
                                    name="title"
                                    type="text"
                                    maxlength="150"
                                    required
                                    style="
                                      width: 100%;
                                      padding: 10px;
                                      margin-top: 5px;
                                    "
                                  >
                                </p>

                                <p>
                                  <label for="document-type">
                                    Document type
                                  </label>
                                  <br>
                                  <select
                                    id="document-type"
                                    name="documentType"
                                    required
                                    style="
                                      width: 100%;
                                      padding: 10px;
                                      margin-top: 5px;
                                    "
                                  >
                                    <option value="">
                                      Select a type
                                    </option>
                                    <option value="operator_manual">
                                      Operator manual
                                    </option>
                                    <option value="installation_manual">
                                      Installation manual
                                    </option>
                                    <option value="parts_manual">
                                      Parts manual
                                    </option>
                                    <option value="service_manual">
                                      Service manual
                                    </option>
                                    <option value="specification">
                                      Specification sheet
                                    </option>
                                    <option value="wiring_diagram">
                                      Wiring diagram
                                    </option>
                                    <option value="other">
                                      Other
                                    </option>
                                  </select>
                                </p>

                                <p>
                                  <label for="document-description">
                                    Description
                                  </label>
                                  <br>
                                  <textarea
                                    id="document-description"
                                    name="description"
                                    maxlength="500"
                                    rows="3"
                                    style="
                                      width: 100%;
                                      padding: 10px;
                                      margin-top: 5px;
                                    "
                                  ></textarea>
                                </p>

                                <p>
                                  <label for="document-file">
                                    PDF file
                                  </label>
                                  <br>
                                  <input
                                    id="document-file"
                                    name="document"
                                    type="file"
                                    accept=".pdf,application/pdf"
                                    required
                                    style="margin-top: 8px;"
                                  >
                                </p>

                                <button
                                  id="document-upload-button"
                                  type="submit"
                                  class="print-button"
                                >
                                  Upload Document
                                </button>

                                <div
                                  id="document-upload-message"
                                  class="print-message"
                                ></div>
                              </form>
                            </div>
                           </div>

                          <div class="section">
                            <h3>Maintenance</h3>

                            <div class="maintenance-card">
                              <div class="maintenance-heading">
                                <h4>Current Operating Hours</h4>
                              </div>

                              <p class="maintenance-detail">
                                <strong>Current reading: </strong>
                                <span id="current-operating-hours">
                                  Not entered
                                </span>
                              </p>

                              <p
                                id="operating-hours-updated"
                                class="future"
                              ></p>

                              <form id="operating-hours-form">
                                <label>
                                  Update operating hours
                                  <input
                                    id="operating-hours-input"
                                    name="operating_hours"
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    required
                                  >
                                </label>

                                <button
                                  type="submit"
                                  class="print-button"
                                >
                                  Save Hours
                                </button>

                                <p
                                  id="operating-hours-message"
                                  class="print-message"
                                  aria-live="polite"
                                ></p>
                              </form>
                            </div>

                            <div class="maintenance-card">
                              <div class="maintenance-heading">
                                <h4>Maintenance Requests</h4>
                              </div>

                              <p class="future">
                                Report a problem or unscheduled
                                maintenance item for this equipment.
                              </p>

                              <form id="maintenance-request-form">
                                <p>
                                  <label>
                                    Title<br>
                                    <input
                                      name="title"
                                      type="text"
                                      maxlength="200"
                                      required
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    >
                                  </label>
                                </p>

                                <p>
                                  <label>
                                    Description<br>
                                    <textarea
                                      name="description"
                                      rows="4"
                                      maxlength="4000"
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    ></textarea>
                                  </label>
                                </p>

                                <p>
                                  <label>
                                    Priority<br>
                                    <select
                                      name="priority"
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    >
                                      <option value="Low">
                                        Low
                                      </option>
                                      <option
                                        value="Normal"
                                        selected
                                      >
                                        Normal
                                      </option>
                                      <option value="High">
                                        High
                                      </option>
                                      <option value="Critical">
                                        Critical
                                      </option>
                                    </select>
                                  </label>
                                </p>

                                <p>
                                  <label>
                                    Reported by<br>
                                    <input
                                      name="reported_by"
                                      type="text"
                                      maxlength="150"
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    >
                                  </label>
                                </p>

                                <p>
                                  <label>
                                    Assigned to<br>
                                    <input
                                      name="assigned_to"
                                      type="text"
                                      maxlength="150"
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    >
                                  </label>
                                </p>

                                <p>
                                  <label>
                                    Target date<br>
                                    <input
                                      name="target_date"
                                      type="date"
                                      style="
                                        width: 100%;
                                        padding: 10px;
                                        margin-top: 5px;
                                      "
                                    >
                                  </label>
                                </p>

                                <button
                                  type="submit"
                                  class="print-button"
                                >
                                  Open Maintenance Request
                                </button>

                                <p
                                  id="maintenance-request-message"
                                  class="print-message"
                                  aria-live="polite"
                                ></p>
                              </form>
                            </div>

                            <div id="maintenance-requests">
                              <p class="future">
                                Loading maintenance requests...
                              </p>
                            </div>

                            <div id="maintenance-schedules">
                              <p class="future">
                                Loading maintenance schedules...
                              </p>
                            </div>
                          </div>

                          <div class="section">
                            <h3>Maintenance History</h3>

                            <div id="maintenance-history">
                              <p class="future">
                                Loading maintenance history...
                              </p>
                            </div>
                          </div>

                        </div>

                      </main>

                      <footer>
                        Quartermaster Aboard
                      </footer>

                     <script>
                     function setupMaintenanceRequestForm() {
                          const form =
                            document.getElementById(
                              'maintenance-request-form'
                            );

                          const message =
                            document.getElementById(
                              'maintenance-request-message'
                            );

                          if (!form || !message) {
                            return;
                          }

                          const button =
                            form.querySelector('button');

                          form.addEventListener(
                            'submit',
                            async (event) => {
                              event.preventDefault();

                              if (
                                !button ||
                                !form.reportValidity()
                              ) {
                                return;
                              }

                              button.disabled = true;
                              message.className =
                                'print-message';
                              message.textContent =
                                'Opening maintenance request...';

                              const submitted =
                                Object.fromEntries(
                                  new FormData(form).entries()
                                );

                              try {
                                const response =
                                  await fetch(
                                    '/plugins/signalk-quartermaster' +
                                    '/asset/' +
                                    '${encodeURIComponent(asset.qr_code)}' +
                                    '/maintenance-requests',
                                    {
                                      method: 'POST',
                                      credentials: 'same-origin',
                                      headers: {
                                        'Content-Type':
                                          'application/json'
                                      },
                                      body: JSON.stringify(
                                        submitted
                                      )
                                    }
                                  );

                                const responseText =
                                  await response.text();

                                let result = {};

                                try {
                                  result =
                                    JSON.parse(responseText);
                                } catch {
                                  result = {};
                                }

                                if (
                                  response.status === 401 ||
                                  response.status === 403
                                ) {
                                  throw new Error(
                                    'Please sign in to Signal K ' +
                                    'with read-write access.'
                                  );
                                }

                                if (!response.ok) {
                                  throw new Error(
                                    result.error ||
                                    responseText ||
                                    'Unable to open maintenance request'
                                  );
                                }

                                message.textContent =
                                  'Maintenance request ' +
                                  result.request.request_number +
                                  ' opened.';

                                form.reset();

                                const priority =
                                  form.elements.namedItem(
                                    'priority'
                                  );

                                if (priority) {
                                  priority.value = 'Normal';
                                }

                                await loadMaintenanceRequests();
                              } catch (error) {
                                message.className =
                                  'print-message print-error';

                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to open maintenance request';
                              } finally {
                                button.disabled = false;
                              }
                            }
                          );
                        }

                     async function saveMaintenanceRequest(
                          request,
                          changes
                        ) {
                          const payload = {
                            title:
                              changes.title !== undefined
                                ? changes.title
                                : request.title,

                            description:
                              changes.description !== undefined
                                ? changes.description
                                : (request.description || ''),

                            priority:
                              changes.priority !== undefined
                                ? changes.priority
                                : request.priority,

                            status:
                              changes.status !== undefined
                                ? changes.status
                                : request.status,

                            reported_by:
                              changes.reported_by !== undefined
                                ? changes.reported_by
                                : (request.reported_by || ''),

                            assigned_to:
                              changes.assigned_to !== undefined
                                ? changes.assigned_to
                                : (request.assigned_to || ''),

                            target_date:
                              changes.target_date !== undefined
                                ? changes.target_date
                                : (request.target_date || ''),

                            closed_date:
                              changes.closed_date !== undefined
                                ? changes.closed_date
                                : (request.closed_date || ''),

                            resolution_notes:
                              changes.resolution_notes !== undefined
                                ? changes.resolution_notes
                                : (request.resolution_notes || '')
                          };

                          const response =
                            await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/maintenance-requests/' +
                              request.id,
                              {
                                method: 'PATCH',
                                credentials: 'same-origin',
                                headers: {
                                  'Content-Type':
                                    'application/json'
                                },
                                body: JSON.stringify(payload)
                              }
                            );

                          const responseText =
                            await response.text();

                          let result = {};

                          try {
                            result =
                              JSON.parse(responseText);
                          } catch {
                            result = {};
                          }

                          if (
                            response.status === 401 ||
                            response.status === 403
                          ) {
                            throw new Error(
                              'Please sign in to Signal K ' +
                              'with read-write access.'
                            );
                          }

                          if (!response.ok) {
                            throw new Error(
                              result.error ||
                              responseText ||
                              'Unable to update maintenance request'
                            );
                          }

                          return result;
                        }

                     function addMaintenanceRequestActions(
                          card,
                          request
                        ) {
                          if (request.status !== 'Open') {
                            return;
                          }

                          const section =
                            document.createElement('div');

                          section.style.borderTop =
                            '1px solid #d7dee3';
                          section.style.marginTop = '14px';
                          section.style.paddingTop = '14px';

                          const editButton =
                            document.createElement('button');

                          editButton.type = 'button';
                          editButton.className =
                            'print-button';
                          editButton.textContent = 'Edit';

                          const closeButton =
                            document.createElement('button');

                          closeButton.type = 'button';
                          closeButton.className =
                            'print-button';
                          closeButton.textContent = 'Close';
                          closeButton.style.marginLeft = '8px';

                          const cancelButton =
                            document.createElement('button');

                          cancelButton.type = 'button';
                          cancelButton.className =
                            'print-button';
                          cancelButton.textContent = 'Cancel';
                          cancelButton.style.marginLeft = '8px';

                          const message =
                            document.createElement('p');

                          message.className =
                            'print-message';
                          message.setAttribute(
                            'aria-live',
                            'polite'
                          );

                          editButton.addEventListener(
                            'click',
                            async () => {
                              const title =
                                window.prompt(
                                  'Request title',
                                  request.title || ''
                                );

                              if (title === null) {
                                return;
                              }

                              if (!title.trim()) {
                                message.textContent =
                                  'A title is required.';
                                return;
                              }

                              const description =
                                window.prompt(
                                  'Description',
                                  request.description || ''
                                );

                              if (description === null) {
                                return;
                              }

                              const priority =
                                window.prompt(
                                  'Priority: Low, Normal, High, or Critical',
                                  request.priority || 'Normal'
                                );

                              if (priority === null) {
                                return;
                              }

                              if (
                                ![
                                  'Low',
                                  'Normal',
                                  'High',
                                  'Critical'
                                ].includes(priority)
                              ) {
                                message.textContent =
                                  'Priority must be Low, Normal, ' +
                                  'High, or Critical.';
                                return;
                              }

                              const assignedTo =
                                window.prompt(
                                  'Assigned to',
                                  request.assigned_to || ''
                                );

                              if (assignedTo === null) {
                                return;
                              }

                              const targetDate =
                                window.prompt(
                                  'Target date (YYYY-MM-DD or blank)',
                                  request.target_date || ''
                                );

                              if (targetDate === null) {
                                return;
                              }

                              editButton.disabled = true;
                              closeButton.disabled = true;
                              cancelButton.disabled = true;

                              message.textContent =
                                'Saving request...';

                              try {
                                await saveMaintenanceRequest(
                                  request,
                                  {
                                    title: title.trim(),
                                    description:
                                      description.trim(),
                                    priority,
                                    assigned_to:
                                      assignedTo.trim(),
                                    target_date:
                                      targetDate.trim()
                                  }
                                );

                                message.textContent =
                                  'Request updated.';

                                await loadMaintenanceRequests();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to update request';

                                editButton.disabled = false;
                                closeButton.disabled = false;
                                cancelButton.disabled = false;
                              }
                            }
                          );

                          closeButton.addEventListener(
                            'click',
                            async () => {
                              const notes =
                                window.prompt(
                                  'Resolution notes - what was done?',
                                  ''
                                );

                              if (notes === null) {
                                return;
                              }

                              if (!notes.trim()) {
                                message.textContent =
                                  'Resolution notes are required ' +
                                  'to close a request.';
                                return;
                              }

                              const confirmed =
                                window.confirm(
                                  'Close ' +
                                  request.request_number +
                                  '?'
                                );

                              if (!confirmed) {
                                return;
                              }

                              editButton.disabled = true;
                              closeButton.disabled = true;
                              cancelButton.disabled = true;

                              message.textContent =
                                'Closing request...';

                              try {
                                await saveMaintenanceRequest(
                                  request,
                                  {
                                    status: 'Closed',
                                    closed_date:
                                      new Date()
                                        .toISOString()
                                        .slice(0, 10),
                                    resolution_notes:
                                      notes.trim()
                                  }
                                );

                                await loadMaintenanceRequests();
                                await loadMaintenanceHistory();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to close request';

                                editButton.disabled = false;
                                closeButton.disabled = false;
                                cancelButton.disabled = false;
                              }
                            }
                          );

                          cancelButton.addEventListener(
                            'click',
                            async () => {
                              const notes =
                                window.prompt(
                                  'Reason for cancellation (optional)',
                                  ''
                                );

                              if (notes === null) {
                                return;
                              }

                              const confirmed =
                                window.confirm(
                                  'Cancel ' +
                                  request.request_number +
                                  '?'
                                );

                              if (!confirmed) {
                                return;
                              }

                              editButton.disabled = true;
                              closeButton.disabled = true;
                              cancelButton.disabled = true;

                              message.textContent =
                                'Cancelling request...';

                              try {
                                await saveMaintenanceRequest(
                                  request,
                                  {
                                    status: 'Cancelled',
                                    closed_date: '',
                                    resolution_notes:
                                      notes.trim()
                                  }
                                );

                                await loadMaintenanceRequests();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to cancel request';

                                editButton.disabled = false;
                                closeButton.disabled = false;
                                cancelButton.disabled = false;
                              }
                            }
                          );

                          section.appendChild(editButton);
                          section.appendChild(closeButton);
                          section.appendChild(cancelButton);
                          section.appendChild(message);

                          card.appendChild(section);
                        }

                     async function loadMaintenanceRequests() {
                          const container =
                            document.getElementById(
                              'maintenance-requests'
                            );

                          if (!container) {
                            return;
                          }

                          try {
                            const response =
                              await fetch(
                                '/plugins/signalk-quartermaster' +
                                '/asset/' +
                                '${encodeURIComponent(asset.qr_code)}' +
                                '/maintenance-requests',
                                {
                                  credentials: 'same-origin'
                                }
                              );

                            const responseText =
                              await response.text();

                            let result = {};

                            try {
                              result =
                                JSON.parse(responseText);
                            } catch {
                              result = {};
                            }

                            if (!response.ok) {
                              throw new Error(
                                result.error ||
                                'Unable to load maintenance requests'
                              );
                            }

                            container.textContent = '';

                            if (
                              !result.requests ||
                              result.requests.length === 0
                            ) {
                              const empty =
                                document.createElement('p');

                              empty.className = 'future';
                              empty.textContent =
                                'No open maintenance requests.';

                              container.appendChild(empty);
                              return;
                            }

                            result.requests.forEach(
                              (request) => {
                                const card =
                                  document.createElement('div');

                                card.className =
                                  'maintenance-card';

                                const heading =
                                  document.createElement('div');

                                heading.className =
                                  'maintenance-heading';

                                const title =
                                  document.createElement('h4');

                                title.textContent =
                                  (request.request_number ||
                                    'Maintenance Request') +
                                  ' - ' +
                                  request.title;

                                const status =
                                  document.createElement('span');

                                status.className =
                                  'maintenance-status ' +
                                  (
                                    request.status === 'Closed'
                                      ? 'status-current'
                                      : request.priority === 'Critical'
                                        ? 'status-overdue'
                                        : request.priority === 'High'
                                          ? 'status-due-soon'
                                          : 'status-baseline'
                                  );

                                status.textContent =
                                  request.status +
                                  ' / ' +
                                  request.priority;

                                heading.appendChild(title);
                                heading.appendChild(status);

                                card.appendChild(heading);

                                const details = [
                                  [
                                    'Reported',
                                    request.reported_date
                                  ],
                                  [
                                    'Reported by',
                                    request.reported_by
                                  ],
                                  [
                                    'Assigned to',
                                    request.assigned_to
                                  ],
                                  [
                                    'Target date',
                                    request.target_date
                                  ],
                                  [
                                    'Closed date',
                                    request.closed_date
                                  ]
                                ];

                                details.forEach(
                                  ([label, value]) => {
                                    if (!value) {
                                      return;
                                    }

                                    const line =
                                      document.createElement('p');

                                    line.className =
                                      'maintenance-detail';

                                    const strong =
                                      document.createElement(
                                        'strong'
                                      );

                                    strong.textContent =
                                      label + ': ';

                                    line.appendChild(strong);
                                    line.appendChild(
                                      document.createTextNode(
                                        String(value)
                                      )
                                    );

                                    card.appendChild(line);
                                  }
                                );

                                if (request.description) {
                                  const description =
                                    document.createElement('p');

                                  description.className =
                                    'maintenance-detail';

                                  description.textContent =
                                    request.description;

                                  card.appendChild(description);
                                }

                                if (request.resolution_notes) {
                                  const resolution =
                                    document.createElement('p');

                                  resolution.className =
                                    'maintenance-detail';

                                  const strong =
                                    document.createElement(
                                      'strong'
                                    );

                                  strong.textContent =
                                    request.status === 'Cancelled'
                                      ? 'Cancellation note: '
                                      : 'Resolution: ';

                                  resolution.appendChild(strong);

                                  resolution.appendChild(
                                    document.createTextNode(
                                      request.resolution_notes
                                    )
                                  );

                                  card.appendChild(resolution);
                                }

                                addMaintenanceRequestActions(
                                  card,
                                  request
                                );

                                container.appendChild(card);
                              }
                            );
                          } catch (error) {
                            container.textContent = '';

                            const message =
                              document.createElement('p');

                            message.className = 'future';

                            message.textContent =
                              error instanceof Error
                                ? error.message
                                : 'Unable to load maintenance requests';

                            container.appendChild(message);
                          }
                        }

                     function setupOperatingHoursForm() {
                          const form =
                            document.getElementById(
                              'operating-hours-form'
                            );

                          const input =
                            document.getElementById(
                              'operating-hours-input'
                            );

                          const message =
                            document.getElementById(
                              'operating-hours-message'
                            );

                          if (!form || !input || !message) {
                            return;
                          }

                          const button =
                            form.querySelector('button');

                          form.addEventListener(
                            'submit',
                            async (event) => {
                              event.preventDefault();

                              if (
                                !button ||
                                !form.reportValidity()
                              ) {
                                return;
                              }

                              button.disabled = true;
                              message.textContent =
                                'Saving operating hours...';

                              try {
                                const response =
                                  await fetch(
                                    window.location.pathname +
                                      '/operating-hours',
                                    {
                                      method: 'POST',
                                      credentials: 'same-origin',
                                      headers: {
                                        'Content-Type':
                                          'text/plain'
                                      },
                                      body: JSON.stringify({
                                        operating_hours:
                                          input.value
                                      })
                                    }
                                  );

                                const responseText =
                                  await response.text();

                                let result = {};

                                try {
                                  result =
                                    JSON.parse(responseText);
                                } catch {
                                  result = {};
                                }

                                if (
                                  response.status === 401 ||
                                  response.status === 403
                                ) {
                                  throw new Error(
                                    'Please sign in to Signal K ' +
                                    'with read-write access.'
                                  );
                                }

                                if (!response.ok) {
                                  throw new Error(
                                    result.error ||
                                    responseText ||
                                    'Unable to save operating hours'
                                  );
                                }

                                message.textContent =
                                  'Operating hours saved.';

                                await loadMaintenanceSchedules();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to save operating hours';
                              } finally {
                                button.disabled = false;
                              }
                            }
                          );
                        }

                     function addCompletionForm(
                          card,
                          schedule
                        ) {
                          const section =
                            document.createElement('div');

                          section.style.borderTop =
                            '1px solid #d7dee3';
                          section.style.marginTop = '16px';
                          section.style.paddingTop = '14px';

                          const heading =
                            document.createElement('strong');

                          heading.textContent =
                            'Record Completed Maintenance';

                          const help =
                            document.createElement('p');

                          help.className = 'future';
                          help.textContent =
                            'Enter maintenance that was ' +
                            'actually completed.';

                          const form =
                            document.createElement('form');

                          form.innerHTML =
                            '<label>Service date ' +
                            '<input name="service_date" ' +
                            'type="date" required></label><br><br>' +

                            '<label>Engine hours ' +
                            '<input name="engine_hours" ' +
                            'type="number" min="0" ' +
                            'step="0.1"></label><br><br>' +

                            '<label>Performed by ' +
                            '<input name="performed_by" ' +
                            'type="text" maxlength="200">' +
                            '</label><br><br>' +

                            '<label>Cost ' +
                            '<input name="cost" type="number" ' +
                            'min="0" step="0.01"></label><br><br>' +

                            '<label>Description<br>' +
                            '<textarea name="description" ' +
                            'rows="3" maxlength="4000" ' +
                            'required style="width:100%">' +
                            '</textarea></label><br><br>' +

                            '<button type="submit" ' +
                            'class="print-button">' +
                            'Record Maintenance</button>' +

                            '<p class="print-message" ' +
                            'aria-live="polite"></p>';

                          const dateInput =
                            form.elements.namedItem(
                              'service_date'
                            );

                          if (dateInput) {
                            dateInput.value =
                              new Date()
                                .toISOString()
                                .slice(0, 10);
                          }

                          const button =
                            form.querySelector('button');

                          const message =
                            form.querySelector(
                              '.print-message'
                            );

                          form.addEventListener(
                            'submit',
                            async (event) => {
                              event.preventDefault();

                              if (
                                !button ||
                                !message ||
                                !form.reportValidity()
                              ) {
                                return;
                              }

                              button.disabled = true;
                              message.textContent =
                                'Recording maintenance...';

                              const submitted =
                                Object.fromEntries(
                                  new FormData(form).entries()
                                );

                              try {
                                const response =
                                  await fetch(
                                    window.location.pathname +
                                      '/maintenance-schedules/' +
                                      schedule.id +
                                      '/complete',
                                    {
                                      method: 'POST',
                                      credentials: 'same-origin',
                                      headers: {
                                        'Content-Type':
                                          'text/plain'
                                      },
                                      body: JSON.stringify(
                                        submitted
                                      )
                                    }
                                  );

                                const responseText =
                                  await response.text();

                                let result = {};

                                try {
                                  result =
                                    JSON.parse(responseText);
                                } catch {
                                  result = {};
                                }

                                if (
                                  response.status === 401 ||
                                  response.status === 403
                                ) {
                                  throw new Error(
                                    'Please sign in to Signal K ' +
                                    'with read-write access.'
                                  );
                                }

                                if (!response.ok) {
                                  throw new Error(
                                    result.error ||
                                    responseText ||
                                    'Unable to record maintenance'
                                  );
                                }

                                message.textContent =
                                  'Maintenance recorded.';

                                await loadMaintenanceSchedules();
                                await loadMaintenanceHistory();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to record maintenance';

                                button.disabled = false;
                              }
                            }
                          );

                          section.appendChild(heading);
                          section.appendChild(help);
                          section.appendChild(form);
                          card.appendChild(section);
                        }

                     function addBaselineForm(
                          card,
                          schedule
                        ) {
                          const section =
                            document.createElement('div');

                          section.style.borderTop =
                            '1px solid #d7dee3';
                          section.style.marginTop = '16px';
                          section.style.paddingTop = '14px';

                          const heading =
                            document.createElement('strong');

                          heading.textContent =
                            schedule.last_completed_date ||
                            schedule.last_completed_hours !== null
                              ? 'Update Baseline'
                              : 'Set Baseline';

                          section.appendChild(heading);

                          const help =
                            document.createElement('p');

                          help.className = 'future';
                          help.textContent =
                            'Enter the most recent known service ' +
                            'date, operating hours, or both.';

                          section.appendChild(help);

                          const form =
                            document.createElement('form');

                          form.dataset.scheduleId =
                            String(schedule.id);

                          const dateLabel =
                            document.createElement('label');

                          dateLabel.textContent =
                            'Last service date ';

                          const dateInput =
                            document.createElement('input');

                          dateInput.type = 'date';
                          dateInput.name =
                            'last_completed_date';

                          dateInput.value =
                            schedule.last_completed_date || '';

                          dateLabel.appendChild(dateInput);

                          const hoursLabel =
                            document.createElement('label');

                          hoursLabel.textContent =
                            ' Hours at last service ';

                          const hoursInput =
                            document.createElement('input');

                          hoursInput.type = 'number';
                          hoursInput.name =
                            'last_completed_hours';
                          hoursInput.min = '0';
                          hoursInput.step = '0.1';

                          if (
                            schedule.last_completed_hours !==
                            null &&
                            schedule.last_completed_hours !==
                            undefined
                          ) {
                            hoursInput.value = String(
                              schedule.last_completed_hours
                            );
                          }

                          hoursLabel.appendChild(hoursInput);

                          const button =
                            document.createElement('button');

                          button.type = 'submit';
                          button.className = 'print-button';
                          button.textContent = 'Save Baseline';

                          const message =
                            document.createElement('p');

                          message.className = 'print-message';
                          message.setAttribute(
                            'aria-live',
                            'polite'
                          );

                          form.addEventListener(
                            'submit',
                            async (event) => {
                              event.preventDefault();

                              if (
                                !dateInput.value &&
                                !hoursInput.value
                              ) {
                                message.textContent =
                                  'Enter a service date, ' +
                                  'operating hours, or both.';

                                return;
                              }

                              button.disabled = true;
                              message.textContent =
                                'Saving baseline...';

                              try {
                                const response = await fetch(
                                  '/plugins/' +
                                  'signalk-quartermaster' +
                                  '/asset/' +
                                  '${encodeURIComponent(asset.qr_code)}' +
                                  '/maintenance-schedules/' +
                                  schedule.id +
                                  '/baseline',
                                  {
                                    method: 'POST',
                                    credentials: 'same-origin',
                                    headers: {
                                      'Content-Type':
                                        'text/plain'
                                    },
                                    body: JSON.stringify({
                                      last_completed_date:
                                        dateInput.value,
                                      last_completed_hours:
                                        hoursInput.value
                                    })
                                  }
                                );

                                const responseText =
                                  await response.text();

                                let result = {};

                                try {
                                  result =
                                    JSON.parse(responseText);
                                } catch {
                                  result = {};
                                }

                                if (
                                  response.status === 401 ||
                                  response.status === 403
                                ) {
                                  throw new Error(
                                    'Please sign in to Signal K ' +
                                    'with read-write access.'
                                  );
                                }

                                if (!response.ok) {
                                  throw new Error(
                                    result.error ||
                                    responseText ||
                                    'Unable to save baseline'
                                  );
                                }

                                message.textContent =
                                  'Baseline saved.';

                                await loadMaintenanceSchedules();
                              } catch (error) {
                                message.textContent =
                                  error instanceof Error
                                    ? error.message
                                    : 'Unable to save baseline';

                                button.disabled = false;
                              }
                            }
                          );

                          form.appendChild(dateLabel);
                          form.appendChild(
                            document.createElement('br')
                          );
                          form.appendChild(
                            document.createElement('br')
                          );
                          form.appendChild(hoursLabel);
                          form.appendChild(
                            document.createElement('br')
                          );
                          form.appendChild(
                            document.createElement('br')
                          );
                          form.appendChild(button);
                          form.appendChild(message);

                          section.appendChild(form);
                          card.appendChild(section);
                        }

                     async function loadMaintenanceSchedules() {
                          const container =
                            document.getElementById(
                              'maintenance-schedules'
                            );

                          if (!container) {
                            return;
                          }

                          try {
                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/maintenance-schedules',
                              {
                                credentials: 'same-origin'
                              }
                            );

                            if (!response.ok) {
                              throw new Error(
                                'Unable to load maintenance schedules'
                              );
                            }

                            const result = await response.json();

                            const hoursDisplay =
                              document.getElementById(
                                'current-operating-hours'
                              );

                            const hoursUpdated =
                              document.getElementById(
                                'operating-hours-updated'
                              );

                            const hoursInput =
                              document.getElementById(
                                'operating-hours-input'
                              );

                            const firstSchedule =
                              result.schedules &&
                              result.schedules.length > 0
                                ? result.schedules[0]
                                : null;

                            if (
                              firstSchedule &&
                              firstSchedule.operating_hours !==
                                null &&
                              firstSchedule.operating_hours !==
                                undefined
                            ) {
                              if (hoursDisplay) {
                                hoursDisplay.textContent =
                                  firstSchedule.operating_hours +
                                  ' hours';
                              }

                              if (hoursInput) {
                                hoursInput.value = String(
                                  firstSchedule.operating_hours
                                );
                              }

                              if (
                                hoursUpdated &&
                                firstSchedule
                                  .operating_hours_updated_at
                              ) {
                                hoursUpdated.textContent =
                                  'Reading updated: ' +
                                  firstSchedule
                                    .operating_hours_updated_at;
                              }
                            }

                            container.textContent = '';

                            if (
                              !result.schedules ||
                              result.schedules.length === 0
                            ) {
                              const empty =
                                document.createElement('p');

                              empty.className = 'future';
                              empty.textContent =
                                'No maintenance schedules have been added.';

                              container.appendChild(empty);
                              return;
                            }

                            const addDetail = (
                              card,
                              label,
                              detail
                            ) => {
                              if (
                                detail === null ||
                                detail === undefined ||
                                detail === ''
                              ) {
                                return;
                              }

                              const row =
                                document.createElement('p');

                              row.className =
                                'maintenance-detail';

                              const heading =
                                document.createElement('strong');

                              heading.textContent = label + ': ';

                              row.appendChild(heading);
                              row.appendChild(
                                document.createTextNode(
                                  String(detail)
                                )
                              );

                              card.appendChild(row);
                            };

                            result.schedules.forEach(
                              (schedule) => {
                                const card =
                                  document.createElement('div');

                                card.className =
                                  'maintenance-card';

                                const heading =
                                  document.createElement('div');

                                heading.className =
                                  'maintenance-heading';

                                const title =
                                  document.createElement('h4');

                                title.textContent =
                                  schedule.task_name;

                                const badge =
                                  document.createElement('span');

                                badge.className =
                                  'maintenance-status ' +
                                  'status-baseline';

                                badge.textContent =
                                  'Baseline Required';

                                let statusLevel = -1;
                                let hoursReadingMissing = false;

                                if (schedule.next_due_date) {
                                  const now = new Date();

                                  const due = new Date(
                                    schedule.next_due_date +
                                    'T23:59:59'
                                  );

                                  const warning =
                                    new Date(due);

                                  warning.setDate(
                                    warning.getDate() -
                                    Number(
                                      schedule.warning_days ||
                                      0
                                    )
                                  );

                                  if (now > due) {
                                    statusLevel = Math.max(
                                      statusLevel,
                                      2
                                    );
                                  } else if (now >= warning) {
                                    statusLevel = Math.max(
                                      statusLevel,
                                      1
                                    );
                                  } else {
                                    statusLevel = Math.max(
                                      statusLevel,
                                      0
                                    );
                                  }
                                }

                                if (
                                  schedule.next_due_hours !==
                                    null &&
                                  schedule.next_due_hours !==
                                    undefined
                                ) {
                                  if (
                                    schedule.operating_hours ===
                                      null ||
                                    schedule.operating_hours ===
                                      undefined
                                  ) {
                                    hoursReadingMissing = true;
                                  } else {
                                    const currentHours = Number(
                                      schedule.operating_hours
                                    );

                                    const dueHours = Number(
                                      schedule.next_due_hours
                                    );

                                    const warningHours =
                                      dueHours -
                                      Number(
                                        schedule.warning_hours ||
                                        0
                                      );

                                    if (
                                      currentHours >= dueHours
                                    ) {
                                      statusLevel = Math.max(
                                        statusLevel,
                                        2
                                      );
                                    } else if (
                                      currentHours >= warningHours
                                    ) {
                                      statusLevel = Math.max(
                                        statusLevel,
                                        1
                                      );
                                    } else {
                                      statusLevel = Math.max(
                                        statusLevel,
                                        0
                                      );
                                    }
                                  }
                                }

                                if (hoursReadingMissing) {
                                  badge.className =
                                    'maintenance-status ' +
                                    'status-baseline';

                                  badge.textContent =
                                    'Hours Reading Required';
                                } else if (statusLevel === 2) {
                                  badge.className =
                                    'maintenance-status ' +
                                    'status-overdue';

                                  badge.textContent = 'Overdue';
                                } else if (statusLevel === 1) {
                                  badge.className =
                                    'maintenance-status ' +
                                    'status-due-soon';

                                  badge.textContent = 'Due Soon';
                                } else if (statusLevel === 0) {
                                  badge.className =
                                    'maintenance-status ' +
                                    'status-current';

                                  badge.textContent = 'Current';
                                }

                                heading.appendChild(title);
                                heading.appendChild(badge);
                                card.appendChild(heading);

                                const intervals = [];

                                if (schedule.interval_months) {
                                  intervals.push(
                                    schedule.interval_months +
                                    ' months'
                                  );
                                }

                                if (schedule.interval_hours) {
                                  intervals.push(
                                    schedule.interval_hours +
                                    ' operating hours'
                                  );
                                }

                                addDetail(
                                  card,
                                  'Interval',
                                  intervals.join(
                                    ' or '
                                  )
                                );

                                const lastCompleted = [];

                                if (
                                  schedule.last_completed_date
                                ) {
                                  lastCompleted.push(
                                    schedule.last_completed_date
                                  );
                                }

                                if (
                                  schedule.last_completed_hours !==
                                  null &&
                                  schedule.last_completed_hours !==
                                  undefined
                                ) {
                                  lastCompleted.push(
                                    schedule.last_completed_hours +
                                    ' hours'
                                  );
                                }

                                addDetail(
                                  card,
                                  'Last completed',
                                  lastCompleted.join(' at ')
                                );

                                const nextDue = [];

                                if (schedule.next_due_date) {
                                  nextDue.push(
                                    schedule.next_due_date
                                  );
                                }

                                if (
                                  schedule.next_due_hours !==
                                  null &&
                                  schedule.next_due_hours !==
                                  undefined
                                ) {
                                  nextDue.push(
                                    schedule.next_due_hours +
                                    ' hours'
                                  );
                                }

                                addDetail(
                                  card,
                                  'Next due',
                                  nextDue.join(' or ')
                                );

                                addDetail(
                                  card,
                                  'Instructions',
                                  schedule.instructions
                                );

                                addCompletionForm(
                                  card,
                                  schedule
                                );

                                addBaselineForm(
                                  card,
                                  schedule
                                );

                                if (
                                  schedule.document_id &&
                                  schedule.document_title
                                ) {
                                  const documentRow =
                                    document.createElement('p');

                                  documentRow.className =
                                    'maintenance-detail';

                                  const documentHeading =
                                    document.createElement(
                                      'strong'
                                    );

                                  documentHeading.textContent =
                                    'Reference: ';

                                  const documentLink =
                                    document.createElement('a');

                                  documentLink.href =
                                    '/plugins/' +
                                    'signalk-quartermaster' +
                                    '/asset/' +
                                    '${encodeURIComponent(asset.qr_code)}' +
                                    '/document/' +
                                    schedule.document_id;

                                  documentLink.target = '_blank';
                                  documentLink.rel = 'noopener';
                                  documentLink.textContent =
                                    schedule.document_title;

                                  documentRow.appendChild(
                                    documentHeading
                                  );

                                  documentRow.appendChild(
                                    documentLink
                                  );

                                  card.appendChild(documentRow);
                                }

                                container.appendChild(card);
                              }
                            );
                          } catch (error) {
                            container.textContent = '';

                            const message =
                              document.createElement('p');

                            message.className = 'future';
                            message.textContent =
                              error instanceof Error
                                ? error.message
                                : 'Unable to load maintenance';

                            container.appendChild(message);
                          }
                        }

                        setupMaintenanceRequestForm();
                        loadMaintenanceRequests();
                        setupOperatingHoursForm();
                        loadMaintenanceSchedules();
                        loadMaintenanceHistory();

                     async function loadMaintenanceHistory() {
                          const container =
                            document.getElementById(
                              'maintenance-history'
                            );

                          if (!container) {
                            return;
                          }

                          try {
                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/maintenance-records',
                              {
                                credentials: 'same-origin'
                              }
                            );

                            if (!response.ok) {
                              throw new Error(
                                'Unable to load maintenance history'
                              );
                            }

                            const result = await response.json();

                            container.textContent = '';

                            if (
                              !result.records ||
                              result.records.length === 0
                            ) {
                              const empty =
                                document.createElement('p');

                              empty.className = 'future';
                              empty.textContent =
                                'No completed maintenance has ' +
                                'been recorded.';

                              container.appendChild(empty);
                              return;
                            }

                            const addHistoryDetail = (
                              card,
                              label,
                              detail
                            ) => {
                              if (
                                detail === null ||
                                detail === undefined ||
                                detail === ''
                              ) {
                                return;
                              }

                              const row =
                                document.createElement('p');

                              row.className =
                                'maintenance-detail';

                              const heading =
                                document.createElement('strong');

                              heading.textContent = label + ': ';

                              row.appendChild(heading);
                              row.appendChild(
                                document.createTextNode(
                                  String(detail)
                                )
                              );

                              card.appendChild(row);
                            };

                            result.records.forEach(
                              (record) => {
                                const card =
                                  document.createElement('div');

                                card.className =
                                  'maintenance-card';

                                const heading =
                                  document.createElement('div');

                                heading.className =
                                  'maintenance-heading';

                                const title =
                                  document.createElement('h4');

                                title.textContent =
                                  record.task_name ||
                                  record.service_type ||
                                  'Completed Maintenance';

                                heading.appendChild(title);
                                card.appendChild(heading);

                                addHistoryDetail(
                                  card,
                                  'Service date',
                                  record.service_date
                                );

                                addHistoryDetail(
                                  card,
                                  'Engine hours',
                                  record.engine_hours !== null &&
                                  record.engine_hours !== undefined
                                    ? record.engine_hours + ' hours'
                                    : null
                                );

                                addHistoryDetail(
                                  card,
                                  'Performed by',
                                  record.performed_by
                                );

                                addHistoryDetail(
                                  card,
                                  'Cost',
                                  record.cost !== null &&
                                  record.cost !== undefined
                                    ? '$' +
                                      Number(record.cost).toFixed(2)
                                    : null
                                );

                                addHistoryDetail(
                                  card,
                                  'Description',
                                  record.description
                                );

                                const nextDue = [];

                                if (record.next_service_date) {
                                  nextDue.push(
                                    record.next_service_date
                                  );
                                }

                                if (
                                  record.next_service_hours !==
                                  null &&
                                  record.next_service_hours !==
                                  undefined
                                ) {
                                  nextDue.push(
                                    record.next_service_hours +
                                    ' hours'
                                  );
                                }

                                addHistoryDetail(
                                  card,
                                  'Next due',
                                  nextDue.join(' or ')
                                );

                                container.appendChild(card);
                              }
                            );
                          } catch (error) {
                            container.textContent = '';

                            const message =
                              document.createElement('p');

                            message.className = 'future';
                            message.textContent =
                              error instanceof Error
                                ? error.message
                                : 'Unable to load maintenance history';

                            container.appendChild(message);
                          }
                        }

                     async function loadAssetDocuments() {
                          const container =
                            document.getElementById(
                              'documents-list'
                            );

                          try {
                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/documents',
                              {
                                credentials: 'same-origin'
                              }
                            );

                            if (!response.ok) {
                              throw new Error(
                                'Unable to load documents'
                              );
                            }

                            const result = await response.json();

                            container.textContent = '';

                            if (
                              !result.documents ||
                              result.documents.length === 0
                            ) {
                              const empty =
                                document.createElement('p');

                              empty.className = 'future';
                              empty.textContent =
                                'No documents are registered.';

                              container.appendChild(empty);
                              return;
                            }

                            result.documents.forEach(
                              (documentRecord) => {
                                const item =
                                  document.createElement('p');

                                const link =
                                  document.createElement('a');

                                link.href =
                                  '/plugins/signalk-quartermaster' +
                                  '/asset/' +
                                  '${encodeURIComponent(asset.qr_code)}' +
                                  '/document/' +
                                  encodeURIComponent(
                                    documentRecord.id
                                  );

                                link.target = '_blank';
                                link.rel = 'noopener';
                                link.textContent =
                                  documentRecord.title ||
                                  documentRecord.file_name;

                                item.appendChild(link);

                                if (documentRecord.description) {


                                  const description =
                                    document.createElement('span');

                                  description.style.display =
                                    'block';

                                  description.style.color =
                                    '#667784';

                                  description.style.fontSize =
                                    '14px';

                                  description.style.marginTop =
                                    '4px';

                                  description.textContent =
                                    documentRecord.description;

                                  item.appendChild(description);
                                }

   const replaceButton =
                                  document.createElement(
                                    'button'
                                  );

                                replaceButton.type = 'button';
                                replaceButton.textContent =
                                  'Replace PDF';

                                replaceButton.style.marginTop =
                                  '10px';

                                replaceButton.style.marginRight =
                                  '10px';

                                replaceButton.style.padding =
                                  '7px 12px';

                                replaceButton.style.border =
                                  '1px solid #17324d';

                                replaceButton.style.borderRadius =
                                  '5px';

                                replaceButton.style.background =
                                  'white';

                                replaceButton.style.color =
                                  '#17324d';

                                replaceButton.style.cursor =
                                  'pointer';

                                replaceButton.addEventListener(
                                  'click',
                                  () => {
                                    replaceAssetDocument(
                                      documentRecord
                                    );
                                  }
                                );

                                item.appendChild(
                                  replaceButton
                                );

                            const deleteButton =
                                  document.createElement(
                                    'button'
                                  );

                                deleteButton.type = 'button';
                                deleteButton.textContent =
                                  'Delete';

                                deleteButton.style.display =
                                  'block';

                                deleteButton.style.marginTop =
                                  '10px';

                                deleteButton.style.padding =
                                  '7px 12px';

                                deleteButton.style.border =
                                  '1px solid #a61b1b';

                                deleteButton.style.borderRadius =
                                  '5px';

                                deleteButton.style.background =
                                  'white';

                                deleteButton.style.color =
                                  '#a61b1b';

                                deleteButton.style.cursor =
                                  'pointer';

                                deleteButton.addEventListener(
                                  'click',
                                  () => {
                                    deleteAssetDocument(
                                      documentRecord
                                    );
                                  }
                                );

                                item.appendChild(
                                  deleteButton
                                );

                                container.appendChild(item);
                              }
                            );
                          } catch (error) {
                            container.innerHTML =
                              '<p class="future">' +
                              'Documents could not be loaded.' +
                              '</p>';
                          }
                        }

 function replaceAssetDocument(
                          documentRecord
                        ) {
                          const filePicker =
                            document.createElement('input');

                          filePicker.type = 'file';
                          filePicker.accept =
                            '.pdf,application/pdf';

                          filePicker.addEventListener(
                            'change',
                            async () => {
                              const replacementFile =
                                filePicker.files &&
                                filePicker.files[0];

                              if (!replacementFile) {
                                return;
                              }

                              const documentName =
                                documentRecord.title ||
                                documentRecord.file_name;

                              const confirmed =
                                window.confirm(
                                  'Replace the PDF for "' +
                                  documentName +
                                  '"? The title, type, and ' +
                                  'description will remain unchanged.'
                                );

                              if (!confirmed) {
                                return;
                              }

                              const message =
                                document.getElementById(
                                  'document-upload-message'
                                );

                              message.className =
                                'print-message';

                              message.textContent =
                                'Replacing PDF...';

                              const formData =
                                new FormData();

                              formData.append(
                                'document',
                                replacementFile
                              );

                              try {
                                const response =
                                  await fetch(
                                    '/plugins/' +
                                    'signalk-quartermaster' +
                                    '/asset/' +
                                    '${encodeURIComponent(asset.qr_code)}' +
                                    '/document/' +
                                    encodeURIComponent(
                                      documentRecord.id
                                    ) +
                                    '/replace',
                                    {
                                      method: 'POST',
                                      credentials:
                                        'same-origin',
                                      body: formData
                                    }
                                  );

                                if (
                                  response.status === 401 ||
                                  response.status === 403
                                ) {
                                  message.className =
                                    'print-message ' +
                                    'print-error';

                                  message.innerHTML =
                                    'Login required. ' +
                                    '<a href="/admin/#/login" ' +
                                    'target="_blank">' +
                                    'Open Signal K login</a>.';

                                  return;
                                }

                                const result =
                                  await response.json();

                                if (
                                  !response.ok ||
                                  !result.ok
                                ) {
                                  throw new Error(
                                    result.error ||
                                    'Replacement failed'
                                  );
                                }

                                if (
                                  result.document &&
                                  result.document
                                    .old_file_removed ===
                                    false
                                ) {
                                  message.className =
                                    'print-message ' +
                                    'print-error';

                                  message.textContent =
                                    'PDF replaced, but the old ' +
                                    'file requires cleanup.';
                                } else {
                                  message.textContent =
                                    'PDF replaced successfully.';
                                }

                                await loadAssetDocuments();
                              } catch (error) {
                                message.className =
                                  'print-message ' +
                                  'print-error';

                                message.textContent =
                                  error.message ||
                                  'Unable to replace PDF.';
                              }
                            }
                          );

                          filePicker.click();
                        }


                         async function deleteAssetDocument(
                          documentRecord
                        ) {
                          const documentName =
                            documentRecord.title ||
                            documentRecord.file_name;

                          const confirmed = window.confirm(
                            'Delete "' +
                            documentName +
                            '"? This removes both the database ' +
                            'record and the stored PDF.'
                          );

                          if (!confirmed) {
                            return;
                          }

                          const message =
                            document.getElementById(
                              'document-upload-message'
                            );

                          message.className =
                            'print-message';

                          message.textContent =
                            'Deleting document...';

                          try {
                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/document/' +
                              encodeURIComponent(
                                documentRecord.id
                              ),
                              {
                                method: 'DELETE',
                                credentials: 'same-origin'
                              }
                            );

                            if (
                              response.status === 401 ||
                              response.status === 403
                            ) {
                              message.className =
                                'print-message print-error';

                              message.innerHTML =
                                'Login required. ' +
                                '<a href="/admin/#/login" ' +
                                'target="_blank">' +
                                'Open Signal K login</a>.';

                              return;
                            }

                            const result =
                              await response.json();

                            if (!response.ok || !result.ok) {
                              throw new Error(
                                result.error ||
                                'Delete failed'
                              );
                            }

                            if (
                              result.deleted &&
                              result.deleted.file_removed === false
                            ) {
                              throw new Error(
                                'The record was deleted, but ' +
                                'file cleanup requires attention.'
                              );
                            }

                            message.textContent =
                              'Document deleted successfully.';

                            await loadAssetDocuments();
                          } catch (error) {
                            message.className =
                              'print-message print-error';

                            message.textContent =
                              error.message ||
                              'Unable to delete document.';
                          }
                        }


                        document.addEventListener(
                          'DOMContentLoaded',
                          loadAssetDocuments
                        );
                        async function uploadAssetDocument(
                          event
                        ) {
                          event.preventDefault();

                          const form = event.currentTarget;

                          const button =
                            document.getElementById(
                              'document-upload-button'
                            );

                          const message =
                            document.getElementById(
                              'document-upload-message'
                            );

                          button.disabled = true;
                          message.className = 'print-message';
                          message.textContent =
                            'Uploading PDF...';

                          try {
                            const formData =
                              new FormData(form);

                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/documents/upload',
                              {
                                method: 'POST',
                                credentials: 'same-origin',
                                body: formData
                              }
                            );

                            if (
                              response.status === 401 ||
                              response.status === 403
                            ) {
                              message.className =
                                'print-message print-error';

                              message.innerHTML =
                                'Login required. ' +
                                '<a href="/admin/#/login" ' +
                                'target="_blank">' +
                                'Open Signal K login</a>.';

                              return;
                            }

                            const result =
                              await response.json();

                            if (!response.ok || !result.ok) {
                              throw new Error(
                                result.error ||
                                'Upload failed'
                              );
                            }

                            message.textContent =
                              'Document uploaded successfully.';

                            form.reset();

                            await loadAssetDocuments();
                          } catch (error) {
                            message.className =
                              'print-message print-error';

                            message.textContent =
                              error.message ||
                              'Unable to upload document.';
                          } finally {
                            button.disabled = false;
                          }
                        }

                        document
                          .getElementById(
                            'document-upload-form'
                          )
                          .addEventListener(
                            'submit',
                            uploadAssetDocument
                          );

                          async function printAssetLabel() {
                          const button =
                            document.getElementById(
                              'print-label-button'
                            );

                          const message =
                            document.getElementById(
                              'print-label-message'
                            );

                          button.disabled = true;
                          message.className = 'print-message';
                          message.textContent =
                            'Sending label to printer...';

                          try {
                            const response = await fetch(
                              '/plugins/signalk-quartermaster' +
                              '/asset/' +
                              '${encodeURIComponent(asset.qr_code)}' +
                              '/print-label',
                              {
                                method: 'POST',
                                credentials: 'same-origin'
                              }
                            );

                            if (
                              response.status === 401 ||
                              response.status === 403
                            ) {
                              message.className =
                                'print-message print-error';

                              message.innerHTML =
                                'Login required. ' +
                                '<a href="/admin/#/login" ' +
                                'target="_blank">' +
                                'Open Signal K login</a>.';

                              return;
                            }

                            const result = await response.json();

                            if (!response.ok || !result.ok) {
                              throw new Error(
                                result.error ||
                                'Unable to print label'
                              );
                            }

                            message.textContent =
                              'Label sent to the configured printer.';
                          } catch (error) {
                            message.className =
                              'print-message print-error';

                            message.textContent =
                              error.message ||
                              'Unable to print label.';
                          } finally {
                            button.disabled = false;
                          }
                        }
                      </script>

                    </body>
                    </html>
                  `)

                  db.close()
                }
              )
            }
          )
        }
      )
    },

    getOpenApi: () => ({
      openapi: '3.0.3',

      info: {
        title: 'Quartermaster Aboard API',
        version: '1.0.0-rc.1'
      },

      paths: {
        '/home': {
          get: {
            summary: 'Display the Quartermaster equipment home screen',
            responses: { '200': { description: 'Home page displayed' } }
          }
        },
        '/equipment/manual': {
          get: {
            summary: 'Display the manual equipment form',
            responses: { '200': { description: 'Form displayed' } }
          },
          post: {
            summary: 'Create equipment without photographs',
            responses: { '303': { description: 'Open the new equipment record' } }
          }
        },
        '/health': {
          get: {
            summary: 'Plugin health check',
            responses: {
              '200': {
                description: 'Plugin is running'
              }
            }
          }
        },

        '/vessel': {
          get: {
            summary: 'Basic vessel identity from Signal K',
            responses: {
              '200': {
                description: 'Vessel identity'
              }
            }
          }
        },

        '/assets/qr/{qrCode}': {
          get: {
            summary: 'Find a Quartermaster asset by QR code',

            parameters: [
              {
                name: 'qrCode',
                in: 'path',
                required: true,

                schema: {
                  type: 'string'
                }
              }
            ],

            responses: {
              '200': {
                description: 'Asset found'
              },

              '404': {
                description: 'Asset not found'
              },

              '500': {
                description: 'Database error'
              }
            }
          }
        },

        '/asset/{qrCode}': {
          get: {
            summary: 'Display a Quartermaster asset web page',

            parameters: [
              {
                name: 'qrCode',
                in: 'path',
                required: true,

                schema: {
                  type: 'string'
                }
              }
            ],

            responses: {
              '200': {
                description: 'Asset page displayed'
              },

              '404': {
                description: 'Asset not found'
              },

              '500': {
                description: 'Database error'
              }
            }
          }
        }
      }
    })
  }

  return plugin
}
