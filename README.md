# Quartermaster-Aboard

Boat equipment documentation by **Open Ocean OS**, running as a Signal K server plugin.

Keep equipment records, photographs, manuals, parts information and maintenance history together on your own Signal K host. QR labels link to equipment records from a phone. Optional AI identification proposes equipment details from photographs for you to review and correct.

## Release status

**1.0.0-rc.1 is a release candidate.** The Pi 4 reference installation and hosted five-lookup AI trial have passed live tests. This repository is being prepared for publication; it does not yet provide a published npm release or a complete customer disk image.

Confirmed live on the reference Pi 4:

- Clean plugin installation and database creation.
- Manual equipment entry and persistence after service restart and reboot.
- Photograph intake, PDF upload and retrieval, including phone access.
- Hosted AI identification and human approval.
- Five successful trial identifications, followed by rejection of a sixth.

Pi 5 acceptance, physical QR label printing/scanning, maintenance workflows and full backup/restore for this release candidate remain pending. Cached retries and failed-request credit handling have automated coverage; live verification remains pending.

## Features

- Vessel equipment records with photographs and PDF manuals.
- Parts, notes and maintenance records and schedules.
- QR access to individual equipment records.
- Optional AI identification with review before approval.
- Optional CUPS/ZPL label printing.

Features listed here are not a claim that every workflow has completed release acceptance testing.

## Requirements

- Node.js 24 or later.
- A working Signal K server with its vessel name and UUID configured.
- A 64-bit operating system for the initial Raspberry Pi deployment.
- Internet access for AI identification.
- For printing: CUPS, a compatible ZPL printer and a tested 3 by 5 inch label layout.

Manual entry and existing records remain available without AI service access.

## Get started

1. Read the [installation guide](docs/INSTALLATION.md).
2. Configure vessel details and the plugin.
3. Open `http://PI_ADDRESS:3000/plugins/signalk-quartermaster/home`.
4. Add an equipment record manually before enabling optional AI.

Replace `PI_ADDRESS` with your own server address and use your actual Signal K port.

## Documentation

- [Installation and network setup](docs/INSTALLATION.md)
- [Basic use and troubleshooting](docs/USAGE.md)
- [Optional AI access and privacy](docs/AI.md)
- [Release notes](CHANGELOG.md)

## Data and access

Equipment data stays on the Signal K host. AI identification sends selected photographs to OpenAI, either directly or through the Open Ocean OS trial service. See the AI guide before submitting photographs.

Signal K permissions apply. QR codes do not bypass login.

## Support

Report reproducible problems through [GitHub Issues](https://github.com/dmaurin2/signalk-quartermaster/issues). Include the plugin, Signal K, Node and operating-system versions, steps to reproduce and relevant redacted errors. Never include tokens, API keys, passwords or private equipment photographs.

Project website: [openoceanos.com](https://openoceanos.com)

## License

The release candidate declares the MIT license. The plugin source and its license file will accompany the code release.
