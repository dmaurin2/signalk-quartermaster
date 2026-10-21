# Basic use

## Add equipment manually

Open Quartermaster, choose the manual equipment entry option, enter the equipment information and save. Open the resulting asset record to add supporting photographs, PDF manuals, parts or notes.

## Identify equipment from photographs

Create a photo intake and upload clear equipment and nameplate photographs. If AI access is configured, select Analyze with AI, review and correct the proposal, then approve and create the equipment record.

AI output can be wrong. Confirm model numbers and technical details against the physical equipment and manufacturer documentation. A completed AI intake presents approval controls; it does not expose another Analyze button in the normal interface.

## Open equipment using QR codes

A printed label links to its equipment record. The phone must be able to reach the configured server address and may need to sign into Signal K. Printed codes do not provide remote internet access to the boat.

Configure and test the printer and address before producing labels. Physical printing and scanning remain pending acceptance checks for this release candidate.

## Troubleshooting

**Unauthorized:** Sign into Signal K in the same browser using the same hostname or IP and port as the Quartermaster page.

**Cannot reach the server:** Verify the current DHCP address and local network connection. Guest Wi-Fi isolation may prevent devices from reaching each other.

**FileZilla connection refused:** If SSH is enabled, use SFTP on port 22 and the host's current address. FTP on port 21 is a different service.

**Missing vessel dimensions:** Save vessel base data in Signal K, restart Signal K and refresh the page.

**AI allowance exhausted:** Manual entry and existing records remain available. Reinstalling the plugin does not reset the trial account.

**Service failure:** On a systemd installation using the reference service name:

```bash
systemctl is-active signalk
sudo journalctl -u signalk -n 50 --no-pager
```

Review and redact logs before sharing them in GitHub Issues.
