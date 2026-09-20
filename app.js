const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);

const el={
  title:$('#sessionTitle'),type:$('#sessionType'),context:$('#sessionContext'),mode:$('#recordMode'),
  mic:$('#micStatus'),timer:$('#timer'),noteTime:$('#noteTime'),dot:$('#liveDot'),state:$('#recState'),
  start:$('#startBtn'),pause:$('#pauseBtn'),mark:$('#markBtn'),review:$('#questionBtn'),stop:$('#stopBtn'),
  note:$('#noteText'),add:$('#addNoteBtn'),timeline:$('#timeline'),
  result:$('#resultCard'),player:$('#audioPlayer'),download:$('#downloadAudioBtn'),
  downloadTranscript:$('#downloadTranscriptBtn'),copyTranscript:$('#copyTranscriptBtn'),
  export:$('#exportNotesBtn'),drive:$('#driveTextBtn'),driveStatus:$('#driveStatus'),
  list:$('#sessionList'),refresh:$('#refreshSessionsBtn'),meter:$('#meter'),install:$('#installBtn'),
  panel:$('#modulePanel'),liveTranscript:$('#liveTranscript'),speechStatus:$('#speechStatus')
};

let rec,stream,session,startAt=0,acc=0,pauseAt=0,tick,installPrompt,audioURL,analyser,ctx,frame;
let recognition=null,shouldListen=false,interimText='';
const DB='aulamemo-db',VS=1,SESS='sessions',CH='chunks';

function db(){return new Promise((ok,no)=>{const r=indexedDB.open(DB,VS);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(SESS))d.createObjectStore(SESS,{keyPath:'id'});if(!d.objectStoreNames.contains(CH)){const s=d.createObjectStore(CH,{keyPath:'id',autoIncrement:true});s.createIndex('sessionId','sessionId',{unique:false})}};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})}
async function put(store,v){const d=await db();return new Promise((ok,no)=>{const t=d.transaction(store,'readwrite');t.objectStore(store).put(v);t.oncomplete=ok;t.onerror=()=>no(t.error)})}
async function add(store,v){const d=await db();return new Promise((ok,no)=>{const t=d.transaction(store,'readwrite');t.objectStore(store).add(v);t.oncomplete=ok;t.onerror=()=>no(t.error)})}
async function allSessions(){const d=await db();return new Promise((ok,no)=>{const r=d.transaction(SESS).objectStore(SESS).getAll();r.onsuccess=()=>ok(r.result.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)));r.onerror=()=>no(r.error)})}
async function chunks(id){const d=await db();return new Promise((ok,no)=>{const r=d.transaction(CH).objectStore(CH).index('sessionId').getAll(id);r.onsuccess=()=>ok(r.result.sort((a,b)=>a.order-b.order));r.onerror=()=>no(r.error)})}
async function removeSession(id){const d=await db();return new Promise((ok,no)=>{const t=d.transaction([SESS,CH],'readwrite');t.objectStore(SESS).delete(id);const r=t.objectStore(CH).index('sessionId').openCursor(IDBKeyRange.only(id));r.onsuccess=()=>{const c=r.result;if(c){c.delete();c.continue()}};t.oncomplete=ok;t.onerror=()=>no(t.error)})}

const fmt=ms=>{let x=Math.max(0,Math.floor(ms/1000));return [Math.floor(x/3600),Math.floor(x%3600/60),x%60].map(v=>String(v).padStart(2,'0')).join(':')};
function elapsed(){if(!session)return 0;if(!rec||rec.state==='inactive')return acc;if(rec.state==='paused')return acc+(pauseAt-startAt);return acc+(Date.now()-startAt)}
function clock(){const t=fmt(elapsed());el.timer.textContent=t;el.noteTime.textContent=t}
function mime(){return ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(x=>MediaRecorder.isTypeSupported(x))||''}
function ext(m=''){return m.includes('mp4')?'m4a':m.includes('ogg')?'ogg':'webm'}
function safe(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

function speechCtor(){return window.SpeechRecognition||window.webkitSpeechRecognition||null}

function updateTranscriptView(){
  if(!el.liveTranscript)return;
  const finalText=(session?.transcript||'').trim();
  const text=[finalText,interimText.trim()].filter(Boolean).join(finalText&&interimText?' ':'');
  el.liveTranscript.textContent=text||'Aquí aparecerá el texto mientras hablas.';
}

function setupRecognition(){
  const Ctor=speechCtor();
  if(!Ctor)return null;
  const r=new Ctor();
  r.lang='es-MX';
  r.continuous=true;
  r.interimResults=true;
  r.maxAlternatives=1;

  r.onstart=()=>{
    if(el.speechStatus)el.speechStatus.textContent='Transcribiendo';
    el.liveTranscript?.classList.add('listening');
  };

  r.onresult=async e=>{
    let interim='';
    let finalAdded='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const txt=e.results[i][0]?.transcript||'';
      if(e.results[i].isFinal)finalAdded+=txt+' ';
      else interim+=txt;
    }
    interimText=interim;
    if(finalAdded&&session){
      const existing=(session.transcript||'').trim();
      session.transcript=(existing?existing+' ':'')+finalAdded.trim();
      await put(SESS,session);
    }
    updateTranscriptView();
  };

  r.onerror=e=>{
    console.warn('SpeechRecognition:',e.error);
    if(['not-allowed','service-not-allowed'].includes(e.error)){
      shouldListen=false;
      if(el.speechStatus)el.speechStatus.textContent='Permiso de voz bloqueado';
      showModule('Transcripción','El navegador bloqueó el reconocimiento de voz. Revisa el permiso del micrófono o usa “Solo grabar audio”.');
    }else if(e.error==='network'){
      if(el.speechStatus)el.speechStatus.textContent='Sin servicio de voz';
    }
  };

  r.onend=()=>{
    el.liveTranscript?.classList.remove('listening');
    if(shouldListen&&rec&&rec.state==='recording'){
      setTimeout(()=>{try{r.start()}catch(_){}},250);
    }else if(el.speechStatus){
      el.speechStatus.textContent=session?.transcript?'Texto guardado':'Sin API';
    }
  };
  return r;
}

function startRecognition(){
  if(!session||session.captureMode!=='audioText')return;
  const Ctor=speechCtor();
  if(!Ctor){
    shouldListen=false;
    if(el.speechStatus)el.speechStatus.textContent='No compatible';
    showModule('Transcripción','Este navegador no ofrece reconocimiento de voz compatible. El audio sí se seguirá grabando. Para transcripción en vivo prueba Chrome o Edge en una computadora.');
    return;
  }
  if(!recognition)recognition=setupRecognition();
  shouldListen=true;
  interimText='';
  try{recognition.start()}catch(_){}
}

function stopRecognition(permanent=true){
  if(permanent)shouldListen=false;
  interimText='';
  updateTranscriptView();
  if(recognition){try{recognition.stop()}catch(_){}}
}

async function start(){
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const m=mime();
    rec=m?new MediaRecorder(stream,{mimeType:m}):new MediaRecorder(stream);
    session={
      id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),
      title:el.title.value.trim()||'Sesión '+new Date().toLocaleDateString('es-MX'),
      type:el.type.value,
      context:el.context.value.trim(),
      captureMode:el.mode?.value||'audioText',
      createdAt:new Date().toISOString(),
      durationMs:0,notes:[],markers:[],transcript:'',
      mimeType:rec.mimeType||m||'audio/webm',complete:false
    };
    await put(SESS,session);
    updateTranscriptView();
    let order=0;
    rec.ondataavailable=e=>e.data?.size&&add(CH,{sessionId:session.id,order:order++,blob:e.data,type:e.data.type||session.mimeType});
    rec.onstop=finish;
    acc=0;startAt=Date.now();rec.start(5000);
    el.mic.textContent='Micrófono activo';el.state.textContent='Grabando';el.dot.classList.add('active');
    [el.pause,el.mark,el.review,el.stop].forEach(b=>b.disabled=false);el.start.disabled=true;
    tick=setInterval(clock,250);meter(stream);

    if(session.captureMode==='audioText'){
      showModule('Transcripción','Habla normalmente. El texto aparecerá en el recuadro superior mientras se graba.');
      startRecognition();
    }else{
      if(el.speechStatus)el.speechStatus.textContent='Solo audio';
      showModule('Transcripción','La sesión está en modo “Solo grabar audio”.');
    }
  }catch(e){
    console.error(e);
    alert('No se pudo acceder al micrófono. Revisa el permiso del navegador.');
  }
}

function pause(){
  if(rec.state==='recording'){
    rec.pause();pauseAt=Date.now();el.state.textContent='Pausado';el.pause.textContent='▶ Reanudar';el.dot.classList.remove('active');
    if(session?.captureMode==='audioText')stopRecognition(false);
  }else if(rec.state==='paused'){
    acc+=pauseAt-startAt;startAt=Date.now();rec.resume();el.state.textContent='Grabando';el.pause.textContent='⏸ Pausar';el.dot.classList.add('active');
    if(session?.captureMode==='audioText')startRecognition();
  }
}

function marker(kind,label){if(!session)return;session.markers.push({kind,label,atMs:elapsed()});put(SESS,session);timeline()}
function note(){const text=el.note.value.trim();if(!text)return;if(!session)return alert('Inicia una grabación para asociar la nota.');session.notes.push({text,atMs:elapsed()});el.note.value='';put(SESS,session);timeline()}
function timeline(){if(!session||(!session.notes.length&&!session.markers.length)){el.timeline.className='timeline empty';el.timeline.textContent='Aquí aparecerán tus notas y marcadores con el minuto exacto.';return}const items=[...session.notes.map(x=>({...x,t:'note'})),...session.markers.map(x=>({...x,t:'mark'}))].sort((a,b)=>a.atMs-b.atMs);el.timeline.className='timeline';el.timeline.innerHTML=items.map(x=>'<div class="item"><div class="time">'+fmt(x.atMs)+'</div><div><b>'+(x.t==='note'?'📝 Nota':x.kind==='important'?'⭐ Importante':'❓ Revisar')+'</b><br>'+safe(x.t==='note'?x.text:x.label)+'</div></div>').join('')}

function stop(){
  if(!rec||rec.state==='inactive')return;
  acc+=rec.state==='paused'?pauseAt-startAt:Date.now()-startAt;session.durationMs=acc;
  stopRecognition(true);
  rec.stop();clearInterval(tick);clock();el.state.textContent='Finalizando';el.dot.classList.remove('active');
  [el.pause,el.mark,el.review,el.stop].forEach(b=>b.disabled=true);
  stream.getTracks().forEach(t=>t.stop());stopMeter();
}

async function finish(){
  await new Promise(r=>setTimeout(r,150));
  const cs=await chunks(session.id),blob=new Blob(cs.map(x=>x.blob),{type:session.mimeType});
  if(audioURL)URL.revokeObjectURL(audioURL);audioURL=URL.createObjectURL(blob);el.player.src=audioURL;
  session.complete=true;session.durationMs=acc;await put(SESS,session);
  el.result.classList.remove('hidden');el.state.textContent='Guardado';el.mic.textContent='Micrófono detenido';el.start.disabled=false;
  if(el.speechStatus)el.speechStatus.textContent=session.transcript?'Texto guardado':'Sin transcripción';
  updateTranscriptView();render();
}

async function getAudioBlob(s=session){
  if(!s)throw new Error('No hay una sesión seleccionada.');
  const cs=await chunks(s.id);
  if(!cs.length)throw new Error('No se encontró audio para esta sesión.');
  return new Blob(cs.map(x=>x.blob),{type:s.mimeType||'audio/webm'});
}

async function download(s=session){if(!s)return;const blob=await getAudioBlob(s);const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=(s.title||'sesion').replace(/\s+/g,'_')+'.'+ext(s.mimeType);a.click();setTimeout(()=>URL.revokeObjectURL(u),2000)}

function downloadTranscript(s=session){
  if(!s||!s.transcript)return alert('Esta sesión todavía no tiene transcripción.');
  const text=['AulaMemo AI','Sesión: '+s.title,'Fecha: '+new Date(s.createdAt).toLocaleString('es-MX'),'','=== TRANSCRIPCIÓN ===','',s.transcript].join('\n');
  const u=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');
  a.href=u;a.download=(s.title||'sesion').replace(/\s+/g,'_')+'_transcripcion.txt';a.click();
  setTimeout(()=>URL.revokeObjectURL(u),2000);
}

async function copyTranscript(s=session){
  if(!s||!s.transcript)return alert('Esta sesión todavía no tiene transcripción.');
  try{await navigator.clipboard.writeText(s.transcript);if(el.speechStatus)el.speechStatus.textContent='Texto copiado';}
  catch(e){alert('No se pudo copiar automáticamente. Puedes seleccionar el texto manualmente.')}
}

function exportNotes(s=session){
  if(!s)return;
  const items=[...(s.notes||[]).map(x=>({...x,t:'NOTA'})),...(s.markers||[]).map(x=>({...x,t:x.kind==='important'?'IMPORTANTE':'REVISAR'}))].sort((a,b)=>a.atMs-b.atMs);
  const text=['AulaMemo AI','Sesión: '+s.title,'Tipo: '+s.type,'Contexto: '+(s.context||'—'),'Fecha: '+new Date(s.createdAt).toLocaleString('es-MX'),'Duración: '+fmt(s.durationMs||0),'','=== TRANSCRIPCIÓN ===','',s.transcript||'Sin transcripción.','','=== NOTAS Y MARCADORES ===','',...items.map(x=>'['+fmt(x.atMs)+'] '+x.t+': '+(x.text||x.label||''))].join('\n');
  const u=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');
  a.href=u;a.download=(s.title||'sesion').replace(/\s+/g,'_')+'_sesion.txt';a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);
}

async function drive(s=session){
  const url=window.AULAMEMO_CONFIG?.appsScriptUrl;
  if(!url)return alert('Falta configurar la URL de Apps Script en config.js.');
  el.driveStatus.textContent='Enviando a Drive...';
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'saveSessionFicha',...s})});
    const d=await r.json();if(!d.ok)throw Error(d.error);el.driveStatus.textContent='Guardado en Drive: '+d.fileName;
  }catch(e){console.error(e);el.driveStatus.textContent='No se pudo guardar en Drive.'}
}

function showModule(title,content){el.panel.innerHTML='<div><h3>'+safe(title)+'</h3><p style="white-space:pre-wrap">'+safe(content)+'</p></div>'}

async function render(){
  const arr=await allSessions();
  el.list.innerHTML=arr.length?arr.map(s=>'<article class="session"><div><b>'+safe(s.title)+'</b><div class="meta">'+safe(s.type)+' · '+new Date(s.createdAt).toLocaleString('es-MX')+' · '+fmt(s.durationMs||0)+(s.transcript?' · ✓ Texto':'')+'</div></div><div class="controls"><button class="btn light" data-a="'+s.id+'">Audio</button><button class="btn light" data-t="'+s.id+'">Texto</button><button class="btn light" data-n="'+s.id+'">Sesión</button><button class="btn danger" data-d="'+s.id+'">Eliminar</button></div></article>').join(''):'<div class="session"><div>No hay sesiones guardadas todavía.</div></div>';
  $$('[data-a]').forEach(b=>b.onclick=()=>download(arr.find(x=>x.id===b.dataset.a)));
  $$('[data-t]').forEach(b=>b.onclick=()=>downloadTranscript(arr.find(x=>x.id===b.dataset.t)));
  $$('[data-n]').forEach(b=>b.onclick=()=>exportNotes(arr.find(x=>x.id===b.dataset.n)));
  $$('[data-d]').forEach(b=>b.onclick=async()=>{const s=arr.find(x=>x.id===b.dataset.d);if(confirm('¿Eliminar '+s.title+'?')){await removeSession(s.id);render()}});
}

function meter(st){try{ctx=new (window.AudioContext||window.webkitAudioContext)();const src=ctx.createMediaStreamSource(st);analyser=ctx.createAnalyser();src.connect(analyser);analyser.fftSize=256;const c=el.meter,g=c.getContext('2d'),v=new Uint8Array(analyser.frequencyBinCount);(function draw(){analyser.getByteFrequencyData(v);const avg=v.reduce((a,b)=>a+b,0)/v.length,w=Math.max(5,c.width*Math.min(1,avg/100)),gr=g.createLinearGradient(0,0,c.width,0);gr.addColorStop(0,'#1f5fbd');gr.addColorStop(.72,'#08285f');gr.addColorStop(1,'#d8a71a');g.clearRect(0,0,c.width,c.height);g.fillStyle='#dbe8fb';g.fillRect(0,0,c.width,c.height);g.fillStyle=gr;g.fillRect(0,0,w,c.height);frame=requestAnimationFrame(draw)})()}catch(e){}}
function stopMeter(){if(frame)cancelAnimationFrame(frame);if(ctx)ctx.close()}

el.start.onclick=start;
el.pause.onclick=pause;
el.mark.onclick=()=>marker('important','Momento marcado como importante');
el.review.onclick=()=>marker('review','Revisar este fragmento después');
el.stop.onclick=stop;
el.add.onclick=note;
el.download.onclick=()=>download();
el.downloadTranscript.onclick=()=>downloadTranscript();
el.copyTranscript.onclick=()=>copyTranscript();
el.export.onclick=()=>exportNotes();
el.drive.onclick=()=>drive();
el.refresh.onclick=render;

$$('.tab').forEach(b=>b.onclick=()=>{
  $$('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  const module=b.dataset.module;
  if(module==='Transcripción'){
    showModule('Transcripción',session?.transcript||'Todavía no hay texto guardado. Inicia una sesión en modo “Grabar audio + transcribir en vivo”.');
    return;
  }
  if(module==='Audio'){showModule('Audio','El audio se guarda localmente y está disponible en el reproductor del bloque Resultado.');return}
  if(module==='Notas'){
    if(!session){showModule('Notas','Todavía no hay una sesión activa.');return}
    const items=[...(session.notes||[]).map(x=>({...x,t:'NOTA'})),...(session.markers||[]).map(x=>({...x,t:x.kind==='important'?'IMPORTANTE':'REVISAR'}))].sort((a,b)=>a.atMs-b.atMs);
    showModule('Notas',items.length?items.map(x=>'['+fmt(x.atMs)+'] '+x.t+': '+(x.text||x.label||'')).join('\n'):'Todavía no hay notas ni marcadores.');
    return;
  }
  const text={
    Resumen:'Este módulo se construirá a partir del texto transcrito, sin obligar al alumno a usar una API de pago.',
    'Mapa mental':'Este módulo se construirá a partir del texto transcrito.',
    Estudiar:'Este módulo se construirá a partir del texto transcrito para generar preguntas y material de repaso.'
  }[module]||'Módulo preparado.';
  showModule(module,text);
});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;el.install.classList.remove('hidden')});
el.install.onclick=async()=>{if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;el.install.classList.add('hidden')}};

if(!speechCtor()){
  if(el.speechStatus)el.speechStatus.textContent='Navegador sin voz';
}else if(el.speechStatus){
  el.speechStatus.textContent='Transcripción disponible';
}

if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));
render();
