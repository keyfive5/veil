// Mock-interview practice. Talks to main via window.veil.practiceTurn (non-streamed).
const $ = (id) => document.getElementById(id);
const feed = $('feed'), empty = $('empty'), answerRow = $('answerRow'), controls = $('controls');
const role = $('role'), answer = $('answer'), cam = $('cam'), speak = $('speak');
const startBtn = $('startBtn'), endBtn = $('endBtn'), sendBtn = $('sendBtn'), recBtn = $('recBtn');

let messages = [];     // [{role, content}] conversation with the interviewer
let context = '';      // saved resume/context from settings, merged with the role field
let busy = false;
let rec = null, recChunks = [], recStream = null;

// Pull the user's saved context so questions are tailored to their background.
window.veil.getSettings().then((s) => { context = s.context || ''; });

// Webcam self-view (optional — for the "video interview" feel).
navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => { cam.srcObject = stream; })
  .catch(() => { cam.outerHTML = '<div class="cam-off">Camera off — that\'s fine, this is just for your own practice.</div>'; });

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function md(t){
  t = esc(t).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');
  const lines = t.split('\n'); let html='', inList=false;
  for (const l of lines){ const m=l.match(/^\s*[-*]\s+(.*)/); if(m){ if(!inList){html+='<ul>';inList=true;} html+=`<li>${m[1]}</li>`; } else { if(inList){html+='</ul>';inList=false;} if(l.trim())html+=`<p>${l}</p>`; } }
  if(inList)html+='</ul>'; return html;
}
function bubble(who, cls, text){
  const d = document.createElement('div'); d.className = `msg ${cls}`;
  d.innerHTML = `<div class="who">${who}</div>${md(text)}`;
  feed.appendChild(d); feed.scrollTop = feed.scrollHeight; return d;
}
function thinking(on){
  let t = $('think');
  if (on && !t){ t = document.createElement('div'); t.id='think'; t.className='thinking'; t.innerHTML='<span class="spin"></span>Interviewer is thinking…'; feed.appendChild(t); feed.scrollTop=feed.scrollHeight; }
  if (!on && t) t.remove();
}
function sayAloud(text){
  if (!speak.checked || !window.speechSynthesis) return;
  const clean = text.replace(/[*_`#>-]/g,' ').replace(/\s+/g,' ').trim();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean); u.rate = 1.02; u.pitch = 1;
  window.speechSynthesis.speak(u);
}

async function turn(userText, isScorecard){
  if (busy) return; busy = true; sendBtn.disabled = true; endBtn.disabled = true;
  if (userText) messages.push({ role: 'user', content: userText });
  thinking(true);
  const res = await window.veil.practiceTurn(messages, [role.value.trim(), context].filter(Boolean).join('\n'));
  thinking(false);
  busy = false; sendBtn.disabled = false; endBtn.disabled = false;
  if (res.error){
    bubble('SYSTEM','q', res.error === 'no-key' ? '**Add your key in the main Veil window first.**' : '**Error: '+res.error+'**');
    return;
  }
  messages.push({ role: 'assistant', content: res.text });
  bubble('INTERVIEWER','q', res.text);
  sayAloud(res.text);
  if (isScorecard){ answerRow.style.display='none'; controls.style.display='none'; endBtn.disabled = true; startBtn.disabled = false; startBtn.textContent = 'Start again ▶'; }
}

startBtn.addEventListener('click', () => {
  if (busy) return;
  empty.style.display = 'none';
  feed.innerHTML = '';
  messages = [];
  answerRow.style.display = 'flex'; controls.style.display = 'flex';
  startBtn.disabled = true; endBtn.disabled = false;
  const r = role.value.trim() || 'a general professional role';
  turn(`Let's begin. I'm interviewing for: ${r}. Introduce yourself in one line as the interviewer, then ask me your first question.`);
});

sendBtn.addEventListener('click', () => {
  const a = answer.value.trim(); if (!a || busy) return;
  bubble('YOU','a', a); answer.value = '';
  turn(a);
});
answer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBtn.click(); } });

endBtn.addEventListener('click', () => {
  if (busy) return;
  bubble('YOU','a', 'That\'s it — please give me my scorecard.');
  turn('That\'s the end of the interview. Give me my scorecard now: a score out of 10, two strengths, and two things to improve.', true);
});

// Voice answer: push-to-talk. Click to record, click to stop → transcribe → fill box.
recBtn.addEventListener('click', async () => {
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    rec.onstop = async () => {
      recBtn.classList.remove('on'); recBtn.textContent = '🎤 Speak';
      recStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1200) return;
      recBtn.disabled = true; recBtn.textContent = '… transcribing';
      try {
        const buf = await blob.arrayBuffer();
        const r = await window.veil.transcribe(buf, rec.mimeType || 'audio/webm');
        if (r && r.text) answer.value = (answer.value ? answer.value + ' ' : '') + r.text;
        else if (r && r.error) answer.placeholder = 'Transcription needs a key (Settings → Live audio).';
      } catch (_) {}
      recBtn.disabled = false; recBtn.textContent = '🎤 Speak';
    };
    rec.start(); recBtn.classList.add('on'); recBtn.textContent = '⏹ Stop';
  } catch (_) { recBtn.textContent = '🎤 (no mic)'; }
});
