export const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PCN Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee}
h1{color:#4ade80}
.stats{display:flex;gap:1rem;margin-bottom:2rem}
.stat{flex:1;padding:1rem;background:#1e1e1e;border-radius:8px;text-align:center}
.stat .val{font-size:2.5rem;color:#4ade80;font-weight:bold}
.stat .label{color:#888;margin-top:.25rem}
.bar{display:flex;align-items:center;margin:.5rem 0}
.bar-name{width:140px;color:#aaa}
.bar-val{color:#4ade80}
pre#events{background:#1a1a1a;padding:1rem;border-radius:8px;max-height:300px;overflow-y:auto;font-size:.85rem;white-space:pre-wrap}
</style></head><body>
<h1>Pi Context Ninja</h1>
<div class="stats">
  <div class="stat"><div id="ctx-pct" class="val">--%</div><div class="label">Context</div></div>
  <div class="stat"><div id="saved" class="val">--</div><div class="label">Tokens Saved</div></div>
  <div class="stat"><div id="turns" class="val">--</div><div class="label">Turns</div></div>
</div>
<h2>Per-Strategy Savings</h2>
<div id="bars"></div>
<h2>Live Events</h2>
<pre id="events"></pre>
<script>
const src=new EventSource('/events');
const el=document.getElementById('events');
src.onmessage=e=>{
  const d=JSON.parse(e.data);
  el.textContent+=d.type+': '+JSON.stringify(d.data)+'\n';
  el.scrollTop=el.scrollHeight;
  if(d.data.contextPercent!=null)document.getElementById('ctx-pct').textContent=(d.data.contextPercent*100).toFixed(1)+'%';
  if(d.data.tokensKeptOutTotal!=null)document.getElementById('saved').textContent=d.data.tokensKeptOutTotal.toLocaleString();
  if(d.data.currentTurn!=null)document.getElementById('turns').textContent=d.data.currentTurn;
  if(d.data.byStrategy){
    const bars=document.getElementById('bars');
    bars.innerHTML=Object.entries(d.data.byStrategy).map(([k,v])=>\`<div class="bar"><span class="bar-name">\${k}</span><span class="bar-val">\${v.toLocaleString()}</span></div>\`).join('');
  }
};
</script></body></html>`;
