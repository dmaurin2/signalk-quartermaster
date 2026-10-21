# Installation

These instructions install the plugin into an existing Signal K server. They do not create a bootable Raspberry Pi image.

## Find your server address

Connect the computer or phone and Signal K host to the same local network. From a terminal on the host:

```bash
hostname
hostname -I
ip -4 -brief address
```

Choose the IPv4 address on the interface connected to your local network. The router's DHCP lease list can also identify the host. If multiple interfaces appear, match the network rather than taking the first address.

Throughout this guide, replace `PI_ADDRESS` with that address. Port `3000` is the reference Signal K port; use your actual configured port. DHCP addresses can change. A router DHCP reservation is useful for a stable address. A hostname such as `YOUR_HOSTNAME.local` is another option after testing resolution from all intended devices.

## Before installing

- Confirm Node.js 24 or later and a working Signal K server.
- Back up the Signal K configuration and Quartermaster data, if present.
- Use the Linux account running Signal K.
- Configure the vessel name and UUID in Signal K.
- Download the release candidate package using the steps below.

This release is distributed through GitHub. Installation through the Signal K App Store is pending npm publication.

## Download the release candidate package

Open [release v1.0.0-rc.1](https://github.com/dmaurin2/signalk-quartermaster/releases/tag/v1.0.0-rc.1). Under Assets download `signalk-quartermaster-1.0.0-rc.1.tgz` and `SHA256SUMS`. The release appears after its automated build and package checks succeed. If it is absent, check the repository Actions page.

Transfer both files to your Signal K host. From the download directory, verify:

```bash
sha256sum -c SHA256SUMS
```

Expect `signalk-quartermaster-1.0.0-rc.1.tgz: OK`. Use the .tgz asset, not GitHub's automatically generated Source code archive.

## Install the release candidate package

Run these commands as the Signal K service's Linux user, from its configuration directory:

```bash
cd /path/to/your/signalk-config
npm install --ignore-scripts /absolute/path/signalk-quartermaster-1.0.0-rc.1.tgz
```

Use the installable `.tgz` inside the test bundle, not the outer bundle archive. Do not use sudo for this local npm install.

On the reference system the configuration directory is `/home/dan/.signalk` and the systemd service is `signalk`. Adapt these names to your installation:

```bash
sudo systemctl restart signalk
systemctl is-active signalk
```

Do not start a second Signal K process against the running server's configuration or ports.

## Configure

Sign into `http://PI_ADDRESS:3000/admin/`. Open Plugin Config, enable Quartermaster Aboard and save.

| Setting | Meaning |
| --- | --- |
| Vessel label | Optional friendly name |
| Database filename | Default `quartermaster.db` |
| AI access | `direct` for an owner API key, or `trial` for an activation token |
| Trial service HTTPS URL | Supplied by Open Ocean OS for trial access |
| CUPS label printer queue | Your configured printer queue |
| Address printed in QR labels | Stable base address reachable by scanning phones, such as `http://PI_ADDRESS:3000` |

AI is optional. Direct mode without a configured key does not enable AI.

After changing vessel base data in Signal K, save, restart Signal K and refresh Quartermaster. This was required to display updated dimensions on the reference system.

## Verify

Open `http://PI_ADDRESS:3000/plugins/signalk-quartermaster/home`. Add equipment manually, upload and retrieve a PDF, and test phone access. Restart the service and verify that records persist.

Use the same hostname or IP and port for dashboard login and Quartermaster pages. Switching origins may require signing in again.

## QR labels and address changes

Choose a stable address before printing. Changing the QR base setting affects future labels; existing labels retain the old address and may need replacement. QR codes require normal Signal K access.

## Upgrade and backup limits

The candidate supports the supplied October 18 reference schema. Migration from older schemas missing columns is not implemented; test upgrades on a restored copy first.

Back up the entire plugin data directory, not just the SQLite file: photographs and documents are separate files. The reference data directory is `/home/dan/.signalk/plugin-config-data/signalk-quartermaster`; the actual location follows the Signal K configuration. Stop Signal K for a consistent whole-directory file copy, or use a backup process that handles the active database correctly. Full recovery acceptance testing for this candidate remains pending.
