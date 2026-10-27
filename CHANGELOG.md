# Changelog

## 1.0.0-rc.1

Release candidate under test; published to npm. Signal K App Store discovery and installation remain to be verified.

### Included

- Local equipment documentation with photographs and PDF manuals.
- Proposed AI identification with human review.
- Hosted five-successful-lookup trial and owner-key AI mode.
- QR record access and optional CUPS/ZPL printing.
- Parts, notes and maintenance features.

### Confirmed live on the Pi 4 reference system

- Clean package installation and database creation.
- Manual entry and persistence after restart and reboot.
- Photo intake, PDF upload/retrieval and phone access.
- Hosted AI analysis and approval.
- Trial limit enforcement after five successful identifications.

### Pending acceptance

- Pi 5 installation with this candidate.
- Physical label printing and QR scanning.
- Maintenance workflow checks.
- Full backup and restore.
- Live retry-cache and failed-request credit checks.

Older database schemas missing required columns do not yet have a complete migration path. Test an upgrade using a backup copy before changing an existing installation.
