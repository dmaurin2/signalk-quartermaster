const base = '/plugins/signalk-quartermaster'

export interface HomeAsset {
  name: string
  category: string | null
  location: string | null
  qr_code: string
}

export const escapeHtml = (input: unknown): string => String(input ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;')

const styles = `
  :root { color-scheme: light; }
  .vessel-details { margin-bottom: 18px; }
  .vessel-grid { display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
    gap: 14px; margin: 0 0 16px; }
  .vessel-grid dt { font-weight: 700; color: #526779; }
  .vessel-grid dd { margin: 4px 0 0; min-height: 1.45em;
    overflow-wrap: anywhere; }

  * { box-sizing: border-box; }
  body { margin: 0; background: #f2f5f7; color: #183044;
    font-family: Arial, Helvetica, sans-serif; line-height: 1.45; }
  a { color: #075f8a; }
  .masthead { background: #17324d; color: #fff; padding: 22px 18px 28px; }
  .wrap { max-width: 1100px; margin: auto; }
  .masthead h1 { margin: 2px 0 3px; font-size: clamp(26px, 4vw, 36px); }
  .masthead p { margin: 0; color: #d6e5ee; }
  .eyebrow { font-size: 13px; font-weight: 700; letter-spacing: .07em;
    text-transform: uppercase; }
  .masthead a { color: #fff; }
  main { padding: 18px; }
  .intro { margin: 0 0 20px; color: #405b6a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
    gap: 16px; }
  .card { background: white; border: 1px solid #d6e0e6;
    border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px #17324d0a; }
  .card h2, .card h3 { margin: 0 0 12px; }
  .card p { margin: 0 0 15px; }
  .section-title { margin: 28px 0 12px; font-size: 22px; }
  .choice { display: flex; align-items: flex-start; gap: 12px; padding: 12px;
    margin: 8px 0; border: 1px solid #c9d6df; border-radius: 8px;
    cursor: pointer; }
  .choice:has(input:checked) { border-color: #14628a; background: #eaf4f9; }
  .choice input { margin-top: 4px; accent-color: #14628a; width: 18px; height: 18px; }
  .choice strong, .choice small { display: block; }
  .choice small { color: #526779; margin-top: 3px; }
  fieldset { padding: 0; border: 0; margin: 0 0 14px; }
  legend { font-size: 21px; font-weight: 700; margin-bottom: 8px; }
  .button { display: inline-flex; align-items: center; justify-content: center;
    min-height: 48px; padding: 11px 18px; border: 0; border-radius: 8px;
    background: #17324d; color: #fff; text-decoration: none; font: inherit;
    font-weight: 700; cursor: pointer; }
  .button:hover, .button:focus-visible { background: #0e5879; }
  .button.secondary { background: #e6f0f5; color: #17324d; }
  .button.secondary:hover, .button.secondary:focus-visible { background: #d3e7f0; }
  .button-list { display: flex; flex-wrap: wrap; gap: 9px; }
  .search { display: flex; flex-wrap: wrap; gap: 9px; margin: 12px 0 16px; }
  input[type="search"], input[type="text"], textarea { width: 100%;
    border: 1px solid #aebfca; border-radius: 8px; padding: 12px;
    font: inherit; color: #183044; background: white; }
  .search input { flex: 1 1 230px; }
  .assets { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .asset h3 { margin-bottom: 5px; }
  .asset p { color: #526779; margin: 0 0 12px; }
  .asset a { font-weight: 700; }
  .muted { color: #526779; }
  .field { margin: 0 0 16px; }
  .field label { display: block; font-weight: 700; margin-bottom: 5px; }
  .field small { display: block; color: #526779; margin-top: 4px; }
  .error { color: #8e2525; border: 1px solid #e9bbbb;
    padding: 12px; border-radius: 8px; background: #fff3f3; }
  .back { display: inline-block; margin-bottom: 16px; font-weight: 700; }
  footer { color: #526779; font-size: 14px; padding: 18px 0 30px; }
  :focus-visible { outline: 3px solid #f0a538; outline-offset: 2px; }
  @media (max-width: 560px) { .button-list .button, .search .button,
    form > .button { width: 100%; } }
`

function documentHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
    <html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Quartermaster</title>
    <style>${styles}</style></head><body>${body}</body></html>`
}

export function renderHome(
  vesselName: string,
  assets: HomeAsset[],
  error = '',
  vesselDetails: Record<string, string> = {}
): string {
  const assetCards = assets.map((asset) => `
    <article class="card asset">
      <h3>${escapeHtml(asset.name)}</h3>
      <p>${escapeHtml(asset.category || 'Equipment')} ·
        ${escapeHtml(asset.location || 'Location not recorded')}<br>
        ${escapeHtml(asset.qr_code)}</p>
      <a href="${base}/asset/${encodeURIComponent(asset.qr_code)}">Open record</a>
    </article>`).join('')

  const vesselPanel = Object.keys(vesselDetails).length ? `
    <section class="card vessel-details" aria-labelledby="vessel-title">
      <h2 id="vessel-title">Vessel details</h2>
      <dl class="vessel-grid">
        ${Object.entries(vesselDetails).map(([label, value]) => `
          <div><dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd></div>`).join('')}
      </dl>
      <p class="muted">Read from Signal K. Refresh this page after changing vessel settings.</p>
    </section>` : ''

  return documentHtml('Home', `
    <header class="masthead"><div class="wrap">
      <div class="eyebrow">Quartermaster Aboard</div>
      <h1>Boat equipment</h1>
      <p>${escapeHtml(vesselName || 'Your vessel')}</p>
    </div></header>
    <main class="wrap">
      ${vesselPanel}
      <p class="intro">Find an equipment record, add an item, or open a saved intake.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <div class="grid">
        <section class="card" aria-labelledby="add-title">
          <h2 id="add-title">Add equipment</h2>
          <form action="${base}/equipment/start" method="get">
            <fieldset><legend>Choose how to start</legend>
              <label class="choice"><input type="radio" name="method" value="photo" checked>
                <span><strong>Take photographs</strong>
                <small>Photograph equipment, nameplate, and location for AI review.</small></span></label>
              <label class="choice"><input type="radio" name="method" value="manual">
                <span><strong>Enter details manually</strong>
                <small>Create a record without photographs or AI.</small></span></label>
            </fieldset>
            <button class="button" type="submit">Continue</button>
          </form>
        </section>
        <section class="card" aria-labelledby="quick-title">
          <h2 id="quick-title">Quick links</h2>
          <p>Open the pages used during a survey and for everyday records.</p>
          <nav class="button-list" aria-label="Quartermaster pages">
            <a class="button secondary" href="${base}/intakes">Photo intakes</a>
            <a class="button secondary" href="${base}/intakes/new">Take equipment photos</a>
            <a class="button secondary" href="${base}/equipment/manual">Manual entry</a>
            <a class="button secondary" href="${base}/health">System status</a>
            <a class="button secondary" href="/admin/#/dashboard">Signal K</a>
          </nav>
        </section>
      </div>
      <section id="equipment" aria-labelledby="equipment-title">
        <h2 class="section-title" id="equipment-title">Equipment (${assets.length})</h2>
        <div class="card search"><label for="asset-search" class="muted">Find equipment</label>
          <input id="asset-search" type="search" placeholder="Name, location, or QR code">
        </div>
        <div class="assets" id="asset-list">${assetCards}</div>
        <p class="muted" id="no-results" hidden>No matching equipment.</p>
        ${assets.length === 0 ? '<p class="muted">No equipment records yet. Use Add equipment to begin.</p>' : ''}
      </section>
      <footer>Manuals, service history, parts, and label printing are available from each equipment record.</footer>
    </main>
    <script>
      const search = document.getElementById('asset-search');
      const cards = [...document.querySelectorAll('#asset-list .asset')];
      const empty = document.getElementById('no-results');
      search.addEventListener('input', () => {
        const needle = search.value.trim().toLocaleLowerCase();
        let matches = 0;
        cards.forEach((card) => {
          const show = card.textContent.toLocaleLowerCase().includes(needle);
          card.hidden = !show;
          if (show) matches++;
        });
        empty.hidden = matches !== 0 || cards.length === 0;
      });
    </script>`)
}

export function renderManualForm(error = '', values: Record<string, string> = {}): string {
  const field = (name: string, label: string, max: number, required = false) => `
    <div class="field"><label for="${name}">${label}${required ? ' *' : ''}</label>
      <input id="${name}" name="${name}" type="text" maxlength="${max}"
        value="${escapeHtml(values[name] || '')}" ${required ? 'required' : ''}></div>`
  return documentHtml('Manual equipment entry', `
    <header class="masthead"><div class="wrap"><div class="eyebrow">Quartermaster Aboard</div>
      <h1>Enter equipment manually</h1><p>Create a record without photographs or AI.</p>
    </div></header>
    <main class="wrap" style="max-width: 760px">
      <a class="back" href="${base}/home">← Quartermaster home</a>
      <section class="card">
        ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
        <form action="${base}/equipment/manual" method="post" enctype="multipart/form-data">
          ${field('name', 'Equipment name', 150, true)}
          ${field('category', 'Category', 100, true)}
          ${field('manufacturer', 'Manufacturer', 150)}
          ${field('model', 'Model', 150)}
          ${field('serial_number', 'Serial number', 150)}
          ${field('part_number', 'Part number', 150)}
          ${field('location', 'Location on board', 200)}
          <div class="field"><label for="description">Description</label>
            <textarea id="description" name="description" maxlength="1500" rows="4">${escapeHtml(values.description || '')}</textarea></div>
          <button class="button" type="submit">Save equipment</button>
        </form>
        <p class="muted" style="margin-top: 18px">Sign in to Signal K with edit access before saving.
          <a href="/admin/#/login">Open sign in</a>.</p>
      </section>
    </main>`)
}
