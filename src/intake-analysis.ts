import OpenAI from 'openai'
import { trialRequest } from './trial-client'
const crypto = require('node:crypto')

const fs = require('node:fs')
const path = require('node:path')
const sqlite3 = require('../sqlite-compat.js').verbose()

export interface AnalyzeIntakeOptions {
  dataDir: string
  databaseFile?: string
  intakeCode: string
  apiKey?: string
  model?: string
  aiMode?: 'direct' | 'trial'
  trialServiceUrl?: string
}

export interface AnalyzeIntakeResult {
  intakeCode: string
  model: string
  result: any
  outputPath: string
  photographs: string[]
}

const allowedPhotographs = [
  'location.jpg',
  'equipment.jpg',
  'nameplate.jpg'
]

const resultSchema = {
  type: 'object',

  properties: {
    equipment_name: {
      type: ['string', 'null']
    },

    category: {
      type: ['string', 'null']
    },

    manufacturer: {
      type: ['string', 'null']
    },

    model: {
      type: ['string', 'null']
    },

    serial_number: {
      type: ['string', 'null']
    },

    part_number: {
      type: ['string', 'null']
    },

    location_suggestion: {
      type: ['string', 'null']
    },

    visible_specifications: {
      type: ['string', 'null']
    },

    plate_text: {
      type: ['string', 'null']
    },

    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 100
    },

    uncertainty_notes: {
      type: 'array',
      items: {
        type: 'string'
      }
    }
  },

  required: [
    'equipment_name',
    'category',
    'manufacturer',
    'model',
    'serial_number',
    'part_number',
    'location_suggestion',
    'visible_specifications',
    'plate_text',
    'confidence',
    'uncertainty_notes'
  ],

  additionalProperties: false
}

function openDatabase(dbPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      dbPath,
      sqlite3.OPEN_READWRITE,
      (error: Error | null) => {
        if (error) {
          reject(error)
          return
        }

        resolve(db)
      }
    )
  })
}

function getRow(
  db: any,
  sql: string,
  parameters: any[]
): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(
      sql,
      parameters,
      (error: Error | null, row: any) => {
        if (error) {
          reject(error)
          return
        }

        resolve(row)
      }
    )
  })
}

function runStatement(
  db: any,
  sql: string,
  parameters: any[]
): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(
      sql,
      parameters,
      function (
        this: {
          changes: number
        },
        error: Error | null
      ) {
        if (error) {
          reject(error)
          return
        }

        resolve(this.changes)
      }
    )
  })
}

function closeDatabase(db: any): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error: Error | null) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function photographDescription(fileName: string): string {
  if (fileName === 'location.jpg') {
    return 'Installation-location photograph'
  }

  if (fileName === 'nameplate.jpg') {
    return 'Manufacturer or model-plate photograph'
  }

  return 'Complete-equipment photograph'
}

export async function analyzeIntake(
  options: AnalyzeIntakeOptions
): Promise<AnalyzeIntakeResult> {
  const intakeCode = String(options.intakeCode || '')
  const validIntakeCode = /^INTAKE-\d{6}$/

  if (!validIntakeCode.test(intakeCode)) {
    throw new Error('Invalid intake code')
  }

  const apiKey =
    options.apiKey || process.env.OPENAI_API_KEY

  const trial = options.aiMode === 'trial'
  if (!trial && !apiKey) {
    throw new Error(
      'The OpenAI API key is not configured'
    )
  }

  let model =
    options.model ||
    process.env.OPENAI_MODEL ||
    'gpt-5.6-terra'

  const databaseFile =
    options.databaseFile || 'quartermaster.db'

  const dbPath = path.join(
    options.dataDir,
    databaseFile
  )

  const intakeDir = path.join(
    options.dataDir,
    'storage',
    'intake',
    intakeCode
  )

  const photographs =
    allowedPhotographs.filter((fileName) => {
      return fs.existsSync(
        path.join(intakeDir, fileName)
      )
    })

  if (photographs.length === 0) {
    throw new Error(
      'At least one intake photograph is required for AI analysis'
    )
  }

  let db: any = null
  let analysisStarted = false

  try {
    db = await openDatabase(dbPath)

    const intake = await getRow(
      db,
      `
        SELECT
          id,
          status,
          approved_asset_id
        FROM asset_intakes
        WHERE intake_code = ?
      `,
      [intakeCode]
    )

    if (!intake) {
      throw new Error('Intake record not found')
    }

    if (
      intake.status === 'approved' ||
      intake.approved_asset_id
    ) {
      throw new Error(
        'Approved intakes cannot be analyzed again'
      )
    }

    await runStatement(
      db,
      `
        UPDATE asset_intakes
        SET
          status = 'analyzing',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [intake.id]
    )

    analysisStarted = true

    const content: any[] = [
      {
        type: 'input_text',

        text:
          'Analyze the available photographs of one piece ' +
          'of vessel equipment. Photograph roles are listed ' +
          'before each image. Extract only information that ' +
          'is visible or reasonably supported. Do not invent ' +
          'missing values.'
      }
    ]

    for (const fileName of photographs) {
      const fullPath = path.join(
        intakeDir,
        fileName
      )

      const base64 = fs.readFileSync(
        fullPath,
        'base64'
      )

      content.push({
        type: 'input_text',
        text: photographDescription(fileName)
      })

      content.push({
        type: 'input_image',
        image_url:
          `data:image/jpeg;base64,${base64}`,
        detail: 'auto'
      })
    }

    let result: any
    if (trial) {
      const identityPath = path.join(options.dataDir, 'trial-installation-id')
      let identity: string
      try {
        identity = fs.readFileSync(identityPath, 'utf8').trim()
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error
        try {
          fs.writeFileSync(identityPath, crypto.randomUUID(), { mode: 0o600, flag: 'wx' })
        } catch (writeError: any) {
          if (writeError.code !== 'EEXIST') throw writeError
        }
        identity = fs.readFileSync(identityPath, 'utf8').trim()
      }
      const photographsForService = photographs.map((name) => ({
        name, base64: fs.readFileSync(path.join(intakeDir, name), 'base64')
      }))
      // Identical photos/intake/installation reuse the cached result after a lost response or local save failure.
      const requestId = crypto.createHash('sha256')
        .update(JSON.stringify([identity, intakeCode, photographsForService])).digest('hex')
      const response = await trialRequest(options.trialServiceUrl || '', 'POST', '/v1/analyze', {
        requestId, photographs: photographsForService
      })
      result = response.result
      model = response.model
    } else {
    const client = new OpenAI({
      apiKey
    })

    const response = await client.responses.create({
      model,

      input: [
        {
          role: 'system',

          content:
            'You identify equipment for a vessel ' +
            'documentation system. Read visible labels and ' +
            'model plates carefully. Do not invent missing ' +
            'information. Use null when a value cannot be ' +
            'determined. List uncertainty in ' +
            'uncertainty_notes. The result is only a proposed ' +
            'record and must be reviewed by a human.'
        },

        {
          role: 'user',
          content
        }
      ] as any,

      text: {
        format: {
          type: 'json_schema',
          name: 'quartermaster_equipment_intake',
          strict: true,
          schema: resultSchema
        }
      }
    })

    result = JSON.parse(response.output_text)

    }

    const outputPath = path.join(
      intakeDir,
      'ai-result.json'
    )

    const temporaryOutputPath =
      `${outputPath}.tmp`

    fs.writeFileSync(
      temporaryOutputPath,
      JSON.stringify(result, null, 2),
      {
        mode: 0o600
      }
    )

    fs.renameSync(
      temporaryOutputPath,
      outputPath
    )

    const changes = await runStatement(
      db,
      `
        UPDATE asset_intakes
        SET
          ai_result_json = ?,
          ai_provider = ?,
          ai_model = ?,
          status = 'ai_complete',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND approved_asset_id IS NULL
      `,
      [
        JSON.stringify(result),
        'OpenAI',
        model,
        intake.id
      ]
    )

    if (changes !== 1) {
      throw new Error(
        'The intake could not be updated'
      )
    }

    await closeDatabase(db)
    db = null

    return {
      intakeCode,
      model,
      result,
      outputPath,
      photographs
    }
  } catch (error) {
    if (db && analysisStarted) {
      try {
        await runStatement(
          db,
          `
            UPDATE asset_intakes
            SET
              status = 'ai_failed',
              updated_at = CURRENT_TIMESTAMP
            WHERE intake_code = ?
              AND approved_asset_id IS NULL
          `,
          [intakeCode]
        )
      } catch {
        // Preserve the original analysis error.
      }
    }

    if (db) {
      try {
        await closeDatabase(db)
      } catch {
        // Preserve the original analysis error.
      }
    }

    throw error
  }
}
