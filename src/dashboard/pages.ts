export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PCN Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee}
h1{color:#4ade80}
.stats{display:flex;gap:1rem;margin-bottom:2rem}
.stat{flex:1;padding:1rem;background:#1e1e1e;border-radius:8px;text-align:center}
.stat .val{font-size:2.5rem;color:#4ade80;font-weight:bold}
.stat .label{color:#888;margin-top:.25rem}
pre#events{background:#1a1a1a;padding:1rem;border-radius:8px;max-height:300px;overflow-y:auto;font-size:.85rem;white-space:pre-wrap}
</style></head><body>
<h1>Pi Context Ninja</h1>
<div class="stats">
  <div class="stat"><div id="ctx-pct" class="val">--%</div><div class="label">Context</div></div>
  <div class="stat"><div id="saved" class="val">--</div><div class="label">Tokens Saved</div></div>
  <div class="stat"><div id="turns" class="val">--</div><div class="label">Turns</div></div>
</div>
<h2>Live Events</h2>
<pre id="events"></pre>
<script>
const source=new EventSource('/events');
const events=document.getElementById('events');
source.onmessage=(event)=>{
  const payload=JSON.parse(event.data);
  events.textContent+=payload.type+': '+JSON.stringify(payload.data)+'\\n';
  events.scrollTop=events.scrollHeight;
  if(payload.type==='snapshot'){
    const d=payload.data;
    if(d?.context?.percent!=null)document.getElementById('ctx-pct').textContent=(d.context.percent*100).toFixed(1)+'%';
    if(d?.totals?.tokensKeptOutApprox!=null)document.getElementById('saved').textContent=d.totals.tokensKeptOutApprox.toLocaleString();
    if(d?.totalTurns!=null)document.getElementById('turns').textContent=d.totalTurns.toLocaleString();
  }
};
</script></body></html>`;
}
