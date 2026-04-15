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
  <div class="stat"><div id="session-id" class="val">--</div><div class="label">Session</div></div>
  <div class="stat"><div id="ctx-pct" class="val">--%</div><div class="label">Context</div></div>
  <div class="stat"><div id="kept-out" class="val">--</div><div class="label">Tokens Kept Out</div></div>
  <div class="stat"><div id="turns" class="val">--</div><div class="label">Turns</div></div>
</div>
<h2>Live Events</h2>
<pre id="events"></pre>
<script>
const events=document.getElementById('events');
const sessionIdEl=document.getElementById('session-id');
const contextPctEl=document.getElementById('ctx-pct');
const keptOutEl=document.getElementById('kept-out');
const turnsEl=document.getElementById('turns');
let currentSessionId=new URLSearchParams(window.location.search).get('sessionId');
let source;
function buildEventUrl(){
  if(typeof currentSessionId!=='string'||currentSessionId.length===0){
    return '/events';
  }
  return '/events?sessionId='+encodeURIComponent(currentSessionId);
}
function bindToSession(sessionId){
  if(typeof sessionId!=='string'||sessionId.length===0||sessionId===currentSessionId){
    return;
  }
  currentSessionId=sessionId;
  const params=new URLSearchParams(window.location.search);
  params.set('sessionId',sessionId);
  const nextSearch=params.toString();
  const nextUrl=window.location.pathname+(nextSearch.length>0?'?'+nextSearch:'');
  window.history.replaceState(null,'',nextUrl);
  source?.close();
  connectEvents();
}
function connectEvents(){
  source=new EventSource(buildEventUrl());
  source.onmessage=handleMessage;
}
function resetSnapshotStats(){
  sessionIdEl.textContent='--';
  contextPctEl.textContent='--%';
  keptOutEl.textContent='--';
  turnsEl.textContent='--';
}
function applySnapshotStats(d){
  if(d==null){
    resetSnapshotStats();
    return;
  }
  sessionIdEl.textContent=typeof d.sessionId==='string'&&d.sessionId.length>0?d.sessionId:'--';
  contextPctEl.textContent=d.context?.percent!=null?(d.context.percent*100).toFixed(1)+'%':'--%';
  keptOutEl.textContent=d.totals?.tokensKeptOutApprox!=null?d.totals.tokensKeptOutApprox.toLocaleString():'--';
  turnsEl.textContent=d.totalTurns!=null?d.totalTurns.toLocaleString():'--';
}
function handleMessage(event){
  const payload=JSON.parse(event.data);
  events.textContent+=payload.type+': '+JSON.stringify(payload.data)+'\\n';
  events.scrollTop=events.scrollHeight;
  if(payload.type==='snapshot'){
    applySnapshotStats(payload.data);
    if(!currentSessionId&&typeof payload.data?.sessionId==='string'&&payload.data.sessionId.length>0){
      bindToSession(payload.data.sessionId);
    }
  }
}
connectEvents();
</script></body></html>`;
}
