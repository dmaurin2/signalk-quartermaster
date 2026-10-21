CREATE TABLE vessels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signalk_uuid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mmsi TEXT,
    configured_label TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    vessel_id INTEGER NOT NULL,

    asset_uuid TEXT NOT NULL UNIQUE,

    name TEXT NOT NULL,
    category TEXT,
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,

    location TEXT,
    description TEXT,

    install_date TEXT,
    purchase_date TEXT,

    status TEXT NOT NULL DEFAULT 'active',

    qr_code TEXT UNIQUE,

    notes TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, part_number TEXT, operating_hours REAL
CHECK (
    operating_hours IS NULL
    OR operating_hours >= 0
), operating_hours_updated_at TEXT,

    FOREIGN KEY (vessel_id)
        REFERENCES vessels(id)
        ON DELETE CASCADE
);
CREATE TABLE asset_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,

    caption TEXT,
    photo_type TEXT,

    is_primary INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE
);
CREATE TABLE asset_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,

    title TEXT,
    document_type TEXT,
    description TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE
);
CREATE TABLE maintenance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    service_date TEXT NOT NULL,
    service_type TEXT,
    description TEXT NOT NULL,

    performed_by TEXT,
    cost REAL,
    engine_hours REAL,

    next_service_date TEXT,
    next_service_hours REAL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, schedule_id INTEGER
    REFERENCES maintenance_schedules(id)
    ON DELETE SET NULL,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE
);
CREATE TABLE asset_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    part_name TEXT NOT NULL,
    part_number TEXT,
    manufacturer TEXT,

    description TEXT,

    quantity_on_hand INTEGER NOT NULL DEFAULT 0,
    reorder_level INTEGER,

    storage_location TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE
);
CREATE TABLE asset_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    note TEXT NOT NULL,
    note_type TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE
);
CREATE TABLE asset_intakes (id INTEGER PRIMARY KEY AUTOINCREMENT, vessel_id INTEGER NOT NULL, intake_code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', storage_path TEXT, location_note TEXT, ai_result_json TEXT, ai_provider TEXT, ai_model TEXT, reviewed_by TEXT, reviewed_at TEXT, approved_asset_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (vessel_id) REFERENCES vessels(id) ON DELETE CASCADE, FOREIGN KEY (approved_asset_id) REFERENCES assets(id) ON DELETE SET NULL);
CREATE TABLE maintenance_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,
    document_id INTEGER,

    task_name TEXT NOT NULL,
    service_type TEXT,
    instructions TEXT,
    document_page TEXT,

    interval_months INTEGER,
    interval_hours REAL,

    warning_days INTEGER NOT NULL DEFAULT 30,
    warning_hours REAL NOT NULL DEFAULT 25,

    last_completed_date TEXT,
    last_completed_hours REAL,

    next_due_date TEXT,
    next_due_hours REAL,

    active INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE,

    FOREIGN KEY (document_id)
        REFERENCES asset_documents(id)
        ON DELETE SET NULL,

    CHECK (
        interval_months IS NOT NULL
        OR interval_hours IS NOT NULL
    ),

    CHECK (
        interval_months IS NULL
        OR interval_months > 0
    ),

    CHECK (
        interval_hours IS NULL
        OR interval_hours > 0
    ),

    CHECK (warning_days >= 0),
    CHECK (warning_hours >= 0),
    CHECK (active IN (0, 1))
);
CREATE TABLE IF NOT EXISTS "maintenance_requests" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    asset_id INTEGER NOT NULL,

    request_number TEXT UNIQUE,

    title TEXT NOT NULL,
    description TEXT,

    priority TEXT NOT NULL DEFAULT 'Normal',
    status TEXT NOT NULL DEFAULT 'Open',

    reported_date TEXT NOT NULL DEFAULT CURRENT_DATE,
    reported_by TEXT,
    assigned_to TEXT,

    target_date TEXT,
    closed_date TEXT,

    resolution_notes TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (asset_id)
        REFERENCES assets(id)
        ON DELETE CASCADE,

    CHECK (
        priority IN (
            'Low',
            'Normal',
            'High',
            'Critical'
        )
    ),

    CHECK (
        status IN (
            'Open',
            'Closed',
            'Cancelled'
        )
    )
);
CREATE INDEX idx_maintenance_schedules_asset
    ON maintenance_schedules(asset_id);
CREATE INDEX idx_maintenance_schedules_due_date
    ON maintenance_schedules(active, next_due_date);
CREATE INDEX idx_maintenance_schedules_due_hours
    ON maintenance_schedules(active, next_due_hours);
CREATE INDEX idx_maintenance_records_asset
    ON maintenance_records(asset_id);
CREATE INDEX idx_maintenance_records_schedule
    ON maintenance_records(schedule_id);
CREATE INDEX idx_maintenance_requests_asset
    ON maintenance_requests(asset_id);
CREATE INDEX idx_maintenance_requests_status
    ON maintenance_requests(status);
CREATE INDEX idx_maintenance_requests_priority
    ON maintenance_requests(priority);
