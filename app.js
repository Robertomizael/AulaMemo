const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);

const el={
  title:$('#sessionTitle'),type:$('#sessionType'),context:$('#sessionContext'),level:$('#educationLevel'),mode:$('#recordMode'),
  mic:$('#micStatus'),timer:$('#timer'),noteTime:$('#noteTime'),dot:$('#liveDot'),state:$('#recState'),
  start:$('#startBtn'),pause:$('#pauseBtn'),mark:$('#markBtn'),review:$('#questionBtn'),stop:$('#stopBtn'),
  note:$('#noteText'),add:$('#addNoteBtn'),timeline:$('#timeline'),
  result:$('#resultCard'),player:$('#audioPlayer'),download:$('#downloadAudioBtn'),
  downloadTranscript:$('#downloadTranscriptBtn'),copyTranscript:$('#copyTranscriptBtn'),
  downloadAI:$('#downloadAIMdBtn'),copyAI:$('#copyAIPromptBtn'),copyMindMap:$('#copyMindMapPromptBtn'),downloadAITxt:$('#downloadAIPromptTxtBtn'),
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
      educationLevel:el.level?.value||'Licenciatura',
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


function mindMapPrompt_(s=session){
  if(!s)return '';
  const level=s.educationLevel||el.level?.value||'Licenciatura';
  const topic=(s.context||s.title||'Tema de la sesión').trim();
  const transcript=(s.transcript||'').trim();
  return [
    'Genera un mapa mental a partir de la siguiente transcripción de audio.',
    '',
    'Identifica el tema central y colócalo en el núcleo. Organiza la información en ramas principales con las ideas clave y en subramas con palabras clave, conceptos breves, ejemplos cortos o relaciones importantes. Usa frases breves, evita párrafos largos y no inventes información.',
    '',
    'Estructura el contenido como un mapa mental visual vertical (9:16) o como un diagrama esquemático con jerarquía clara: centro → ramas principales → subramas. Sugiere íconos y colores diferenciados para cada rama, con conectores visuales limpios y tipografía clara.',
    '',
    'Adapta el vocabulario, la profundidad temática y los ejemplos al nivel educativo de '+level+', para facilitar el repaso rápido y la asociación de ideas.',
    '',
    'Datos:',
    '- Sesión: '+(s.title||'Sin título'),
    '- Contexto o materia: '+(s.context||'Sin contexto'),
    '- Tema sugerido: '+topic,
    '- Nivel educativo: '+level,
    '- Transcripción:',
    transcript||'[Sin transcripción disponible]',
    '',
    'Entrega:',
    '1. Tema central',
    '2. Ramas principales',
    '3. Subramas',
    '4. Íconos sugeridos por rama',
    '5. Colores sugeridos por rama',
    '6. Mapa mental final estructurado y breve',
    '',
    'Criterios de calidad:',
    '- Prioriza conceptos y palabras clave.',
    '- Evita bloques de texto continuo.',
    '- Mantén fidelidad al contenido de la transcripción.',
    '- Si una parte es ambigua o insuficiente, indícalo y no inventes datos.'
  ].join('\n');
}

async function copyMindMapPrompt(s=session){
  if(!s)return alert('Primero realiza una sesión.');
  if(!s.transcript)return alert('Primero genera una transcripción.');
  try{
    await navigator.clipboard.writeText(mindMapPrompt_(s));
    if(el.speechStatus)el.speechStatus.textContent='Prompt de mapa mental copiado';
  }catch(e){
    alert('No se pudo copiar automáticamente el prompt del mapa mental.');
  }
}

function aiPackage_(s=session){
  if(!s)return '';
  const items=[...(s.notes||[]).map(x=>({...x,t:'NOTA'})),...(s.markers||[]).map(x=>({...x,t:x.kind==='important'?'IMPORTANTE':'REVISAR'}))].sort((a,b)=>a.atMs-b.atMs);
  const transcript=(s.transcript||'').trim();
  return [
    '# AulaMemo AI — Paquete universal para análisis con IA',
    '',
    '**Sesión:** '+(s.title||'Sin título'),
    '**Tipo:** '+(s.type||'—'),
    '**Contexto o materia:** '+(s.context||'—'),
    '**Nivel educativo:** '+(s.educationLevel||'Licenciatura'),
    '**Fecha:** '+new Date(s.createdAt).toLocaleString('es-MX'),
    '**Duración:** '+fmt(s.durationMs||0),
    '',
    '## Instrucciones para la IA',
    '',
    'Analiza solamente el contenido incluido en este archivo. No inventes datos. Si falta información, indícalo claramente.',
    '',
    'Genera:',
    '1. Resumen académico estructurado.',
    '2. Mapa mental jerárquico con tema central, ramas y subramas. Para este producto sigue además las instrucciones específicas del apartado “Prompt especializado para mapa mental”.',
    '3. Conceptos clave con definiciones breves.',
    '4. Diez preguntas de repaso con respuesta.',
    '5. Diez flashcards en formato Pregunta | Respuesta.',
    '6. Guía de estudio organizada por temas.',
    '7. Glosario de términos relevantes.',
    '8. Dudas, contradicciones o temas que requieran verificación.',
    '9. Relaciones importantes entre conceptos, teorías, variables o procedimientos.',
    '10. Mantén lenguaje claro, académico y fiel a la sesión.',
    '',
    '## Prompt especializado para mapa mental',
    '',
    mindMapPrompt_(s),
    '',
    '## Transcripción',
    '',
    transcript||'[Sin transcripción disponible]',
    '',
    '## Notas y marcadores',
    '',
    items.length?items.map(x=>'- ['+fmt(x.atMs)+'] **'+x.t+'**: '+(x.text||x.label||'')).join('\n'):'[Sin notas o marcadores]',
    '',
    '## Cierre',
    '',
    'Distingue entre información explícita de la sesión e inferencias o sugerencias generadas.'
  ].join('\n');
}

function downloadTextFile_(text,fileName,mime='text/plain;charset=utf-8'){
  const u=URL.createObjectURL(new Blob([text],{type:mime})),a=document.createElement('a');
  a.href=u;a.download=fileName;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);
}

function downloadAIMarkdown(s=session){
  if(!s)return alert('Primero realiza una sesión.');
  if(!s.transcript&&!((s.notes||[]).length||(s.markers||[]).length))return alert('La sesión todavía no tiene contenido para exportar.');
  downloadTextFile_(aiPackage_(s),(s.title||'sesion').replace(/\s+/g,'_')+'_para_IA.md','text/markdown;charset=utf-8');
  if(el.speechStatus)el.speechStatus.textContent='Archivo para IA descargado';
}

function downloadAITxt(s=session){
  if(!s)return alert('Primero realiza una sesión.');
  if(!s.transcript&&!((s.notes||[]).length||(s.markers||[]).length))return alert('La sesión todavía no tiene contenido para exportar.');
  downloadTextFile_(aiPackage_(s),(s.title||'sesion').replace(/\s+/g,'_')+'_prompt_IA.txt');
  if(el.speechStatus)el.speechStatus.textContent='Prompt descargado';
}

async function copyAI(s=session){
  if(!s)return alert('Primero realiza una sesión.');
  const pack=aiPackage_(s);
  if(!pack)return alert('No hay contenido disponible.');
  try{
    await navigator.clipboard.writeText(pack);
    if(el.speechStatus)el.speechStatus.textContent='Paquete para IA copiado';
  }catch(e){
    alert('No se pudo copiar automáticamente. Usa la descarga del archivo .md.');
  }
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

function words_(text=''){
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-záéíóúñü0-9]{3,}/gi)||[];
}

const STOP_=new Set(('que de la el en y a los las un una unos unas del al se por para con no es su lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tus ellas nosotras vosotros vosotras os mio mia mios mias tuyo tuya tuyos tuyas suyo suya suyos suyas nuestro nuestra nuestros nuestras vuestro vuestra vuestros vuestras esos esas estoy estas esta estamos estan este esteis esten estar estaras estara estaremos estareis estaran estaria estarias estariamos estariais estarian estaba estabas estabamos estabais estaban estuve estuviste estuvo estuvimos estuvisteis estuvieron estuviera estuvieras estuvieramos estuvierais estuvieran estuviese estuvieses estuviesemos estuvieseis estuviesen estando estado estada estados estadas estoy esta estamos estan').split(/\s+/));

function splitSentences_(text=''){
  return String(text).replace(/\s+/g,' ').trim().split(/(?<=[.!?])\s+|\s{2,}/).map(s=>s.trim()).filter(s=>s.length>20);
}

function keywords_(text='',limit=8){
  const freq={};
  for(const w0 of words_(text)){
    const w=w0.toLowerCase();
    if(STOP_.has(w)||w.length<4)continue;
    freq[w]=(freq[w]||0)+1;
  }
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([w,n])=>({word:w,count:n}));
}

function summaryLocal_(text=''){
  const sentences=splitSentences_(text);
  if(!sentences.length)return text.trim()||'No hay transcripción suficiente para generar un resumen.';
  if(sentences.length<=3)return sentences.join(' ');
  const keys=new Map(keywords_(text,14).map((x,i)=>[x.word,14-i]));
  const scored=sentences.map((s,i)=>{
    const ws=words_(s).map(w=>w.toLowerCase());
    const score=ws.reduce((a,w)=>a+(keys.get(w)||0),0)+(i===0?5:0);
    return {s,i,score};
  });
  const take=Math.min(5,Math.max(3,Math.ceil(sentences.length*.3)));
  return scored.sort((a,b)=>b.score-a.score).slice(0,take).sort((a,b)=>a.i-b.i).map(x=>'• '+x.s).join('\n');
}

function mindMapLocal_(text='',title='Tema central'){
  const keys=keywords_(text,6);
  if(!keys.length)return 'No hay suficiente texto para construir el mapa mental.';
  const sentences=splitSentences_(text);
  let out=(title||'Tema central').toUpperCase()+'\n';
  keys.forEach((k,i)=>{
    out+='\n'+(i===keys.length-1?'└── ':'├── ')+capitalize_(k.word);
    const related=sentences.filter(s=>words_(s).some(w=>w.toLowerCase()===k.word)).slice(0,2);
    related.forEach((s,j)=>{
      const short=s.length>105?s.slice(0,102)+'…':s;
      out+='\n    '+(j===related.length-1?'└─ ':'├─ ')+short;
    });
  });
  return out;
}

function studyLocal_(text=''){
  const keys=keywords_(text,5);
  const sentences=splitSentences_(text);
  if(!keys.length||!sentences.length)return 'No hay suficiente texto para generar material de estudio.';
  const lines=['PREGUNTAS DE REPASO'];
  keys.forEach((k,i)=>{
    const s=sentences.find(x=>words_(x).some(w=>w.toLowerCase()===k.word))||sentences[i%sentences.length];
    lines.push('\n'+(i+1)+'. ¿Qué se explicó acerca de '+k.word+'?');
    lines.push('   Respuesta guía: '+s);
  });
  lines.push('\nCONCEPTOS CLAVE\n'+keys.map(k=>'• '+capitalize_(k.word)).join('\n'));
  return lines.join('\n');
}

function notesLocal_(s){
  if(!s)return 'Todavía no hay una sesión activa.';
  const keys=keywords_(s.transcript||'',7);
  const items=[...(s.notes||[]).map(x=>({...x,t:'NOTA'})),...(s.markers||[]).map(x=>({...x,t:x.kind==='important'?'IMPORTANTE':'REVISAR'}))].sort((a,b)=>a.atMs-b.atMs);
  const parts=[];
  if(keys.length)parts.push('CONCEPTOS CLAVE\n'+keys.map(k=>'• '+capitalize_(k.word)).join('\n'));
  if(items.length)parts.push('NOTAS Y MARCADORES\n'+items.map(x=>'['+fmt(x.atMs)+'] '+x.t+': '+(x.text||x.label||'')).join('\n'));
  if(s.transcript)parts.push('SÍNTESIS\n'+summaryLocal_(s.transcript));
  return parts.join('\n\n')||'Todavía no hay notas ni transcripción.';
}

function capitalize_(s=''){return s.charAt(0).toUpperCase()+s.slice(1)}

async function render(){
  const arr=await allSessions();
  el.list.innerHTML=arr.length?arr.map(s=>'<article class="session"><div><b>'+safe(s.title)+'</b><div class="meta">'+safe(s.type)+' · '+new Date(s.createdAt).toLocaleString('es-MX')+' · '+fmt(s.durationMs||0)+(s.transcript?' · ✓ Texto':'')+'</div></div><div class="controls"><button class="btn light" data-a="'+s.id+'">Audio</button><button class="btn light" data-t="'+s.id+'">Texto</button><button class="btn light" data-n="'+s.id+'">Sesión</button><button class="btn goldbtn" data-ai="'+s.id+'">Para IA</button><button class="btn danger" data-d="'+s.id+'">Eliminar</button></div></article>').join(''):'<div class="session"><div>No hay sesiones guardadas todavía.</div></div>';
  $$('[data-a]').forEach(b=>b.onclick=()=>download(arr.find(x=>x.id===b.dataset.a)));
  $$('[data-t]').forEach(b=>b.onclick=()=>downloadTranscript(arr.find(x=>x.id===b.dataset.t)));
  $('[data-n]').forEach(b=>b.onclick=()=>exportNotes(arr.find(x=>x.id===b.dataset.n)));
  $('[data-ai]').forEach(b=>b.onclick=()=>downloadAIMarkdown(arr.find(x=>x.id===b.dataset.ai)));
  $('[data-d]').forEach(b=>b.onclick=async()=>{const s=arr.find(x=>x.id===b.dataset.d);if(confirm('¿Eliminar '+s.title+'?')){await removeSession(s.id);render()}});
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
if(el.downloadAI)el.downloadAI.onclick=()=>downloadAIMarkdown();
if(el.copyAI)el.copyAI.onclick=()=>copyAI();
if(el.copyMindMap)el.copyMindMap.onclick=()=>copyMindMapPrompt();
if(el.downloadAITxt)el.downloadAITxt.onclick=()=>downloadAITxt();
el.export.onclick=()=>exportNotes();
el.drive.onclick=()=>drive();
el.refresh.onclick=render;

$('.tab').forEach(b=>b.onclick=()=>{
  $('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  const module=b.dataset.module;
  const transcript=session?.transcript?.trim()||'';

  if(module==='Transcripción'){
    showModule('Transcripción',transcript||'Todavía no hay texto guardado. Inicia una sesión en modo “Grabar audio + transcribir en vivo”.');
    return;
  }

  if(module==='Audio'){
    showModule('Audio','El audio se guarda localmente y está disponible en el reproductor del bloque Resultado.');
    return;
  }

  if(!session){
    showModule(module,'Primero realiza una grabación para usar este módulo.');
    return;
  }

  if(module==='Resumen'){
    showModule('Resumen',transcript?summaryLocal_(transcript):'Primero genera una transcripción.');
    return;
  }

  if(module==='Mapa mental'){
    showModule('Mapa mental',transcript?mindMapLocal_(transcript,session.context||session.title)+'\n\nTIP: Usa el botón “🧠 Prompt mapa mental” en Resultado para llevar la transcripción a la IA que prefieras y generar una versión visual 9:16 con íconos, colores y nivel educativo adaptado.':'Primero genera una transcripción.');
    return;
  }

  if(module==='Estudiar'){
    showModule('Estudiar',transcript?studyLocal_(transcript):'Primero genera una transcripción.');
    return;
  }

  if(module==='Notas'){
    showModule('Notas',notesLocal_(session));
    return;
  }
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
