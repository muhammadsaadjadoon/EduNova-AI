const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const sameOrigin=location.protocol==='http:'||location.protocol==='https:';
const DEFAULT_API=sameOrigin?'':'http://127.0.0.1:8000';
let API=localStorage.getItem('aqg_api_base')||DEFAULT_API;


/*
  REFRESH SESSION FIX:
  After a successful login, the current browser tab keeps the active session during refresh.
  Logout still clears the session fully.
*/


let SESSION=null;
const state={source:'text',count:10,pdf:null,quiz:[],sessionId:null,answered:{},submitted:false,filter:'all',startedAt:null,timer:null,history:[],flash:0,flashBack:false,mcqPrompted:false,retakeContext:null,activeAssignmentMeta:null};
function readJSONRaw(v){try{return JSON.parse(v||'null')}catch{return null}}
function readJSON(k,f){try{const v=JSON.parse(localStorage.getItem(k)||'');return v??f}catch{return f}}
function writeJSON(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch{return false}}
function safe(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function messageText(value,fallback='Something went wrong. Please try again.'){if(value==null)return fallback;if(value instanceof Error)return messageText(value.message,fallback);if(typeof value==='string'){const t=value.trim();return t&&t!=='[object Object]'?t:fallback}if(Array.isArray(value))return value.map(v=>messageText(v,'')).filter(Boolean).join(' · ')||fallback;if(typeof value==='object'){return messageText(value.detail||value.message||value.error||value.raw||JSON.stringify(value),fallback)}return String(value)||fallback}
function toast(msg,type='success'){const wrap=$('#toastWrap');const el=document.createElement('div');el.className='toast '+type;el.textContent=messageText(msg);wrap.appendChild(el);setTimeout(()=>el.remove(),3800)}
function setBusy(btn,on){if(!btn)return;btn.disabled=!!on;btn.dataset.old=btn.dataset.old||btn.innerHTML;if(on)btn.innerHTML='Working...';else btn.innerHTML=btn.dataset.old}
function responseErrorMessage(data,statusText){return messageText(data?.detail||data?.message||data?.error||data?.raw||statusText||'Request failed','Request failed. Please try again.')}
async function refreshAuthSession(){
  if(!SESSION?.refresh_token)return false;
  try{
    const res=await fetch(API+'/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:SESSION.refresh_token})});
    if(!res.ok)return false;
    const data=await res.json();
    SESSION={...SESSION,...data};persistSession();return true;
  }catch{return false}
}
async function request(path,opt={}){
  const isForm=opt.body instanceof FormData;
  const isAuthPublic=/^\/auth\/(login|signup|forgot-password|reset-password|refresh)$/.test(path);
  const headers=isForm?{}:{'Content-Type':'application/json'};
  if(!isAuthPublic&&SESSION?.access_token)headers.Authorization='Bearer '+SESSION.access_token;
  const url=(path.startsWith('http')?path:(API+path));
  let res=await fetch(url,{...opt,headers:{...headers,...(opt.headers||{})}});
  if(res.status===401&&!isAuthPublic&&!opt._retried&&await refreshAuthSession()){
    return request(path,{...opt,_retried:true});
  }
  let data=null;const text=await res.text();try{data=text?JSON.parse(text):null}catch{data={raw:text}};
  if(!res.ok){
    if(res.status===401&&!isAuthPublic){sessionStorage.removeItem('aqg_session');SESSION=null;showAuth()}
    throw new Error(responseErrorMessage(data,res.statusText));
  }
  return data
}
function icon(id){return `<svg class="icon"><use href="#${id}"></use></svg>`}
function applyTheme(){const p=readJSON('aqg_prefs',{});document.body.dataset.theme=p.theme||'dark'}
function authTab(name){['login','signup','forgot'].forEach(x=>{$('#'+x+'Form')?.classList.toggle('hidden',x!==name)});$$('#authTabs .tab').forEach((b,i)=>b.classList.toggle('active',(name==='login'&&i===0)||(name==='signup'&&i===1)))}
function pickRole(btn){$$('.role-option').forEach(b=>b.classList.remove('active'));btn.classList.add('active')}
function togglePassword(id,btn){const el=$('#'+id);el.type=el.type==='password'?'text':'password';btn.textContent=el.type==='password'?'show':'hide'}
function validateSignupLive(){const u=$('#s_user').value.trim(),e=$('#s_email').value.trim(),p=$('#s_pass').value,c=$('#s_confirm').value;const rules={len:p.length>=8,up:/[A-Z]/.test(p),low:/[a-z]/.test(p),num:/\d/.test(p),spec:/[!@#$%^&*(),.?]/.test(p)};for(const [k,v] of Object.entries(rules)){$('#pr_'+k).classList.toggle('ok',v)};const userOk=/^[a-zA-Z0-9_]{3,30}$/.test(u);const emailOk=/^[\w.-]+@[\w.-]+\.\w{2,}$/.test(e);const confirmOk=p&&p===c;setHint('#userHint',userOk,'Username looks good.','Use 3–30 letters, numbers, and underscore only.');setHint('#emailHint',emailOk,'Email looks good.','Enter a valid email address.');setHint('#confirmHint',confirmOk,'Passwords match.','Both passwords must match.');return userOk&&emailOk&&confirmOk&&Object.values(rules).every(Boolean)}
function setHint(sel,ok,good,bad){const el=$(sel);el.textContent=ok?good:bad;el.classList.toggle('ok',ok);el.classList.toggle('bad',!ok)}
function sessionKey(){return SESSION?.user_id||SESSION?.username||'guest'}
function roleCacheKey(id){return 'aqg_role_'+id}
function getRole(){return String(SESSION?.role||localStorage.getItem(roleCacheKey(SESSION?.user_id))||'student').toLowerCase()==='teacher'?'teacher':'student'}
function activePanelKey(){return 'aqg_active_panel_'+sessionKey()}
function isPanelAllowed(id){return !!(id&&(NAV[getRole()]||[]).some(x=>x[0]===id))||['profilePanel','teacherProfilePanel','aboutPanel','historyPanel','statsPanel','generatePanel'].includes(id)}
function defaultPanel(){return getRole()==='teacher'?'teacherDashboard':'studentDashboard'}
function savedPanel(){
  const id=localStorage.getItem(activePanelKey());
  if(isPanelAllowed(id))return id;
  const p=readJSON('aqg_prefs',{});
  const start=p.startPage&&p.startPage[getRole()];
  return isPanelAllowed(start)?start:defaultPanel()
}


/*
  SESSION STORAGE UPDATE:
  Login now survives a normal refresh in the same browser tab.
  The account will only close when the user clicks Sign Out or the tab session is cleared.
*/


function persistSession(){if(SESSION)sessionStorage.setItem('aqg_session',JSON.stringify(SESSION))}
function restoreSession(){const cached=readJSONRaw(sessionStorage.getItem('aqg_session'));if(cached&&(cached.user_id||cached.username)){const role=cached.role||(cached.user_id?localStorage.getItem(roleCacheKey(cached.user_id)):null)||cached.selected_role||'student';SESSION={...cached,role};if(SESSION.user_id)localStorage.setItem(roleCacheKey(SESSION.user_id),SESSION.role);return true}return false}
function saveSession(obj,remember=false){const cached=obj.user_id?localStorage.getItem(roleCacheKey(obj.user_id)):null;SESSION={...obj,role:(obj.role||cached||obj.selected_role||'student')};persistSession();localStorage.removeItem('aqg_session_remember');if(SESSION.user_id)localStorage.setItem(roleCacheKey(SESSION.user_id),SESSION.role);paintUser();showApp()}
async function signup(){const btn=$('#signupBtn');if(!validateSignupLive())return toast('Please fix signup fields first','error');const role=$('.role-option.active')?.dataset.role||'student';try{setBusy(btn,true);const d=await request('/auth/signup',{method:'POST',body:JSON.stringify({username:$('#s_user').value.trim(),email:$('#s_email').value.trim(),password:$('#s_pass').value,role})});d.role=d.role||role;d.selected_role=role;saveSession(d,true);toast('Clean '+role+' account created','success')}catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}}
async function login(){const btn=$('#loginBtn'),u=$('#l_user').value.trim(),p=$('#l_pass').value;if(!u||!p)return toast('Enter username and password','error');try{setBusy(btn,true);const d=await request('/auth/login',{method:'POST',body:JSON.stringify({username:u,password:p})});const remember=$('#rememberMe').checked;if(remember)localStorage.setItem('aqg_remember_username',u);else localStorage.removeItem('aqg_remember_username');saveSession(d,remember);toast('Signed in','success')}catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}}
async function forgotPassword(){const btn=$('#forgotBtn'),email=$('#fp_email').value.trim().toLowerCase(),area=$('#resetArea'),tokenInput=$('#rp_token'),passInput=$('#rp_pass');if(area)area.classList.add('hidden');if(tokenInput)tokenInput.value='';if(passInput)passInput.value='';if(!email)return toast('Enter your registered email','error');if(!/^[\w.-]+@[\w.-]+\.\w{2,}$/.test(email))return toast('Enter a valid email address','error');try{setBusy(btn,true);const d=await request('/auth/forgot-password',{method:'POST',body:JSON.stringify({email})});if(!d?.ok)throw new Error('Reset request could not be completed.');area?.classList.remove('hidden');if(d.reset_token&&tokenInput)tokenInput.value=d.reset_token;toast(d.email_sent?'Reset code sent to the registered email.':'Reset request accepted. Development code is ready in the secure input.','success')}catch(e){area?.classList.add('hidden');toast(messageText(e,'Reset request failed. Please try again.'),'error')}finally{setBusy(btn,false)}}


/*
  SECURE RESET PASSWORD UPDATE:
  Password cannot be changed from a displayed token anymore.
  The user must enter a reset code manually, which should be delivered to the real account email.
*/
async function resetPassword(){const token=$('#rp_token')?.value.trim(),new_password=$('#rp_pass')?.value;if(!token||!new_password)return toast('Reset code and new password are required','error');if(new_password.length<8||!/[A-Z]/.test(new_password)||!/[a-z]/.test(new_password)||!/[0-9]/.test(new_password)||!/[!@#$%^&*(),.?]/.test(new_password))return toast('Use a stronger password: 8+ chars, uppercase, lowercase, number, and special character.','error');try{await request('/auth/reset-password',{method:'POST',body:JSON.stringify({token,new_password})});toast('Password reset. Sign in again.','success');$('#rp_token').value='';$('#rp_pass').value='';$('#resetArea')?.classList.add('hidden');authTab('login')}catch(e){toast(messageText(e,'Reset failed. Check your reset code and try again.'),'error')}}
function showAuth(){$('#authView').classList.add('active');$('#appView').classList.remove('active')}
function showApp(){$('#authView').classList.remove('active');$('#appView').classList.add('active');document.body.classList.remove('drawer-collapsed');renderForRole();checkHealth();if(getRole()==='teacher')loadTeacherProfile(false);else loadProfile(false);setTimeout(()=>{if(innerWidth<860)document.body.classList.add('drawer-collapsed')},200)}


/*
  LOGOUT CLEANUP UPDATE:
  Sign Out is the only action that clears the saved tab session.
  A normal refresh keeps the current login active.
*/


async function logout(){const current=SESSION;try{if(current?.access_token)await request('/auth/logout',{method:'POST',body:JSON.stringify({refresh_token:current.refresh_token||null})})}catch(e){console.warn('Server logout warning',e)}sessionStorage.removeItem('aqg_session');localStorage.removeItem('aqg_session_remember');SESSION=null;state.quiz=[];state.answered={};showAuth();toast('Signed out','success')}
function avatarHTML(size=''){const name=SESSION?.username||'?';const init=name.slice(0,1).toUpperCase();if(SESSION?.avatar_b64)return `<img src="${SESSION.avatar_b64}" alt="Profile photo">`;return safe(init)}
function paintUser(){if(!SESSION)return;const display=profileDetails().fullName||SESSION.username||'User';['#topAvatar','#sideAvatar','#profilePhoto','#teacherProfilePhoto'].forEach(sel=>{const el=$(sel);if(el)el.innerHTML=avatarHTML()});['#topName','#sideName'].forEach(sel=>{$(sel).textContent=display});['#topEmail','#sideEmail'].forEach(sel=>{$(sel).textContent=SESSION.email||'-'});$('#sideRole').textContent=getRole()==='teacher'?'Teacher':'Student';$('#modeBadge').textContent=getRole()==='teacher'?'Teacher Portal':'Student Portal';const cls=typeof studentJoinedCodes==='function'?studentJoinedCodes():[];const teacherInvite=getRole()==='teacher'?(typeof teacherCode==='function'?String(teacherCode()||'').trim().toUpperCase():''):'';$('#sideClassCode').textContent=getRole()==='teacher'?(teacherInvite||'No teacher code'):(cls.length?(cls.length+' class'+(cls.length>1?'es':'')):'No class');}
function toggleDrawer(){document.body.classList.toggle('drawer-collapsed')}
function closeDrawer(){document.body.classList.add('drawer-collapsed')}


/*
  ROLE PROFILE ROUTING UPDATE:
  The top profile pill opens the teacher profile for teachers and the student profile for students.
*/


function openActiveProfile(){showPanel(getRole()==='teacher'?'teacherProfilePanel':'profilePanel')}
const NAV={student:[['studentDashboard','Dashboard','i-dashboard'],['generatePanel','Generate Quiz','i-quiz'],['studentClassesPanel','Classes','i-class'],['sAssignmentsPanel','Assessments','i-send'],['historyPanel','History & Review','i-history'],['statsPanel','Performance','i-chart'],['revisionPanel','Revision Studio','i-book'],['profilePanel','Profile','i-user'],['aboutPanel','App Vision','i-shield']],teacher:[['teacherDashboard','Teacher Console','i-dashboard'],['teacherQuizPanel','Assign Quiz','i-send'],['teacherAssignmentsPanel','Assessments','i-quiz'],['teacherStudentsPanel','Classes','i-users'],['teacherAnalyticsPanel','Class Analytics','i-chart'],['teacherProfilePanel','Teacher Profile','i-user'],['aboutPanel','App Vision','i-shield']]};
function renderForRole(){const r=getRole(),active=savedPanel();document.body.dataset.role=r;const nav=$('#nav');nav.innerHTML=NAV[r].map(n=>`<button class="nav-btn ${n[0]===active?'active':''}" data-panel="${n[0]}" onclick="showPanel('${n[0]}',this)">${icon(n[2])}<span>${n[1]}</span></button>`).join('');$$('.panel').forEach(p=>p.classList.remove('active'));$('#'+active)?.classList.add('active');paintUser();renderAll();renderPanel(active)}
function showPanel(id,btn){if(!isPanelAllowed(id)){toast('This section is not available for your role','error');return}$('#teacherQuizPanel')?.classList.remove('assignment-preview-only');localStorage.setItem(activePanelKey(),id);$$('.panel').forEach(p=>p.classList.remove('active'));$('#'+id)?.classList.add('active');$$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.panel===id));if(btn)btn.classList.add('active');if(innerWidth<860)closeDrawer();renderPanel(id)}
function resetTeacherQuizWorkspaceView(){const panel=$('#teacherQuizPanel');panel?.classList.remove('assignment-preview-only');const box=$('#teacherPreviewBox');if(box)box.innerHTML='';renderTeacherAssignPreview()}
function renderPanel(id){if(id==='studentDashboard')renderStudentDashboard();if(id==='teacherDashboard')renderTeacherDashboard();if(id==='historyPanel')loadHistory();if(id==='statsPanel')renderStats();if(id==='profilePanel')loadProfile(false);if(id==='teacherProfilePanel')loadTeacherProfile(false);if(id==='studentClassesPanel'||id==='sAssignmentsPanel')renderStudentAssignments();if(id==='teacherQuizPanel'){renderTeacherClassSelect();resetTeacherQuizWorkspaceView();}if(id==='teacherAssignmentsPanel')renderTeacherAssignments();if(id==='teacherStudentsPanel')renderTeacherStudents();if(id==='teacherAnalyticsPanel')renderTeacherAnalytics();if(id==='revisionPanel')renderRevision();}
function renderAll(){if(getRole()==='teacher'){renderTeacherDashboard();renderTeacherAssignments();renderTeacherStudents();}else{renderStudentDashboard();renderStudentAssignments();renderStats();renderRevision()}}
async function checkHealth(){try{const d=await request('/health');$('#healthDot').className='dot ok';$('#healthTxt').textContent='Online'}catch(e){$('#healthDot').className='dot bad';$('#healthTxt').textContent='Offline'}}
function setSource(type){state.source=type;$('#textSeg').classList.toggle('active',type==='text');$('#pdfSeg').classList.toggle('active',type==='pdf');$('#textPane').classList.toggle('active',type==='text');$('#pdfPane').classList.toggle('active',type==='pdf');$('#sourceBadge').textContent=type.toUpperCase()}
function pickCount(n,btn){state.count=n;$$('.count-card').forEach(b=>b.classList.remove('active'));btn.classList.add('active');$('#customCount').value=''}
function getCount(){let c=parseInt($('#customCount').value||state.count||10,10);if(!Number.isFinite(c)||c<1)c=10;if(c>250)c=250;return c}
function updateTextStats(){const t=$('#textData').value||'';const words=(t.match(/\b\w+\b/g)||[]).length;const sentences=(t.match(/[.!?]+/g)||[]).length;$('#charCount').textContent=t.length+' chars';$('#statWords').textContent=words;$('#statSentences').textContent=sentences;$('#statRead').textContent=Math.max(1,Math.round(getCount()*0.1))+'m'}
function clearPdf(){state.pdf=null;$('#pdfInput').value='';$('#fileLine').classList.remove('show')}
function handlePdf(file){if(!file)return;if(file.type!=='application/pdf')return toast('Select a PDF file','error');state.pdf=file;$('#fileName').textContent=file.name;$('#fileSize').textContent=(file.size/1024/1024).toFixed(2)+' MB';$('#fileLine').classList.add('show')}
function focusQuizMode(on=true){const p=$('#generatePanel');if(!p)return;p.classList.toggle('quiz-focus-mode',!!on);if(on){localStorage.setItem(activePanelKey(),'generatePanel');setTimeout(()=>$('#quizCard')?.scrollIntoView({behavior:'smooth',block:'start'}),60)}}
function createNewQuiz(){state.quiz=[];state.sessionId=null;state.answered={};state.submitted=false;state.lastResult=null;state.mcqPrompted=false;state.retakeContext=null;state.activeAssignmentMeta=null;state.currentSessionAssignmentMeta=null;clearInterval(state.timer);$('#timerBadge').textContent='00:00';$('#progressBadge').textContent='0/0 answered';$('#scorePanel').classList.remove('show');showPanel('generatePanel');focusQuizMode(false);renderQuiz();setTimeout(()=>$('#sourceCard')?.scrollIntoView({behavior:'smooth',block:'start'}),70)}
function resultBand(pct){return pct>=85?'Excellent academic performance':pct>=70?'Strong learning result':pct>=50?'Good progress shown':'Focused revision needed'}
function resultAdvice(pct,wrong,skipped){if(pct>=85)return 'Excellent work. Keep this level by reviewing highlighted mistakes and retaking weak questions once.';if(pct>=70)return 'Strong attempt. Review the wrong answers, revise missed concepts, and retake for a higher score.';if(pct>=50)return 'Good effort. Focus on the highlighted wrong answers and use revision cards before attempting again.';return 'Revision is needed. Start with wrong answers, read the source notes again, then retake a shorter practice test.'}
function closeResultPop(){const m=$('#resultPop');if(m)m.classList.remove('show')}
function openStoredResultPop(){const r=state.lastResult;if(r)openResultPop(r.score,r.total,r.answered,r.wrong,r.skipped,r.pct,r.title,r.time,r.at,r.comparison)}
function comparisonHTML(c){
  if(!c)return '';
  const cls=c.diff>0?'good':c.diff<0?'danger':'brand';
  const sign=c.diff>0?'+':'';
  return `<div class="result-compare-card"><div class="result-compare-head"><span class="badge ${cls}">RETAKE COMPARISON</span><b>${safe(c.status)}</b></div><div class="result-compare-grid"><div><span>Previous Score</span><b>${c.previousPct}%</b></div><div><span>Current Score</span><b>${c.currentPct}%</b></div><div><span>Change</span><b>${sign}${c.diff}%</b></div></div><small>${safe(c.message)}</small></div>`;
}
function openResultPop(score,total,answered,wrong,skipped,pct,title,time,at,comparison=null){
  const p=profileDetails(),learner=p.fullName||SESSION.username||'Student',v=x=>safe(x||'Not added'),ready=['fullName','academicId','institute','department','class','email'].filter(k=>String(k==='email'?(p.email||SESSION.email||''):(p[k]||'')).trim()).length,profilePct=Math.round(ready/6*100),attemptAt=at||new Date().toLocaleString();
  let m=$('#resultPop');
  if(!m){document.body.insertAdjacentHTML('beforeend','<div id="resultPop" class="result-pop"><div class="result-pop-card" id="resultPopCard"></div></div>');m=$('#resultPop');m.addEventListener('click',e=>{if(e.target.id==='resultPop')closeResultPop()})}
  $('#resultPopCard').innerHTML=`<button class="result-pop-x" onclick="closeResultPop()" style="position:absolute;right:14px;top:14px;z-index:2">×</button><div class="result-pop-head"><div class="result-avatar">${avatarHTML()}</div><div><span class="badge good">OFFICIAL STUDENT RESULT CARD</span><h2 class="result-pop-title">${safe(resultBand(pct))}</h2><div class="result-pop-sub"><b>${safe(learner)}</b> completed <b>${safe(title)}</b> in ${safe(time)}. Compact academic summary is ready with score, profile, and retake review.</div></div></div><div class="result-score-row"><div class="main"><span>Final Score</span><b>${pct}%</b></div><div><span>Correct</span><b>${score}/${total}</b></div><div><span>Wrong</span><b>${wrong}</b></div><div><span>Skipped</span><b>${skipped}</b></div><div><span>Answered</span><b>${answered}/${total}</b></div></div>${comparisonHTML(comparison)}<div class="result-academic-card"><div class="result-academic-head"><span class="badge brand">ACADEMIC PROFILE</span><b>${profilePct}% ready</b></div><div class="result-detail-grid"><div><span>Student</span><b>${safe(learner)}</b></div><div><span>Roll / ID</span><b>${v(p.academicId)}</b></div><div><span>Institute</span><b>${v(p.institute)}</b></div><div><span>Department</span><b>${v(p.department)}</b></div><div><span>Class / Semester</span><b>${v(p.class)}</b></div><div><span>Email</span><b>${v(p.email||SESSION.email)}</b></div></div></div><div class="result-detail-grid result-quiz-grid"><div><span>Quiz Title</span><b>${safe(title)}</b></div><div><span>Status</span><b>${answered===total?'Completed':'Partially Attempted'}</b></div><div><span>Date</span><b>${safe(attemptAt)}</b></div></div><div class="result-advice"><b>Academic Review:</b> ${safe(resultAdvice(pct,wrong,skipped))}</div><div class="result-pop-actions"><button class="btn ghost small" onclick="downloadResultPDF()">Download Result PDF</button><button class="btn ghost small" onclick="closeResultPop()">Review Answers</button><button class="btn primary small" onclick="closeResultPop();createNewQuiz()">Create New Quiz</button></div>`;
  m.classList.add('show')
}
function startTimer(){clearInterval(state.timer);state.startedAt=Date.now();state.timer=setInterval(()=>{const s=Math.floor((Date.now()-state.startedAt)/1000);$('#timerBadge').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')},1000)}

function closeMcqDownloadPop(){const m=$('#mcqDownloadPop');if(m)m.classList.remove('show')}
function showMcqDownloadPop(force=false){
  if(!state.quiz.length)return;
  if(state.mcqPrompted&&!force)return;
  state.mcqPrompted=true;
  const p=profileDetails(),title=$('#quizTitle').value.trim()||'Generated MCQ Practice',learner=p.fullName||SESSION?.username||'Student';
  const source=state.source==='pdf'?'PDF Source':'Text Notes',total=state.quiz.length,first=state.quiz[0]?.question||'MCQs are ready for academic practice.';
  let m=$('#mcqDownloadPop');
  if(!m){document.body.insertAdjacentHTML('beforeend','<div id="mcqDownloadPop" class="result-pop"><div class="result-pop-card" id="mcqDownloadCard"></div></div>');m=$('#mcqDownloadPop');m.addEventListener('click',e=>{if(e.target.id==='mcqDownloadPop')closeMcqDownloadPop()})}
  $('#mcqDownloadCard').innerHTML=`<button class="result-pop-x" onclick="closeMcqDownloadPop()" style="position:absolute;right:18px;top:18px;z-index:2">×</button><div class="result-pop-head"><div class="result-avatar">${avatarHTML()}</div><div><span class="badge brand">MCQ PDF READY</span><h2 class="result-pop-title">Download Study Pack</h2><div class="result-pop-sub"><b>${safe(learner)}</b>, your quiz is ready. You can download a professional MCQ PDF with options and answer key before attempting the test.</div></div></div><div class="mcq-pop-intro"><b>${safe(title)}</b><br>${safe(first)}</div><div class="mcq-pop-metrics"><div><span>Total MCQs</span><b>${total} Questions</b></div><div><span>Source</span><b>${safe(source)}</b></div><div><span>Answer Key</span><b>Included</b></div><div><span>Attempt Needed</span><b>No</b></div></div><div class="mcq-pop-note"><b>Professional PDF:</b> includes academic header, student details, quiz details, numbered MCQs, all options, answer key, and revision notes.</div><div class="result-pop-actions"><button class="btn primary" onclick="downloadMCQsPDF();closeMcqDownloadPop()">Download MCQs PDF</button><button class="btn ghost" onclick="closeMcqDownloadPop()">Start Quiz</button><button class="btn ghost" onclick="closeMcqDownloadPop();createNewQuiz()">Create New Quiz</button></div>`;
  m.classList.add('show');
}
function promptMcqDownloadOnce(){setTimeout(()=>showMcqDownloadPop(false),520)}

async function generateQuiz(){if(!SESSION)return toast('Sign in first','error');const btn=$('#genBtn');state.answered={};state.submitted=false;state.quiz=[];state.sessionId=null;state.lastResult=null;state.currentSessionAssignmentMeta=null;$('#scorePanel').classList.remove('show');try{setBusy(btn,true);let d;if(state.source==='pdf'){if(!state.pdf)return toast('Upload a PDF first','error');const fd=new FormData();fd.append('count',Math.min(getCount(),100));fd.append('title',$('#quizTitle').value.trim()||'PDF review draft');fd.append('file',state.pdf);d=await request('/api/v1/ai/drafts/pdf',{method:'POST',body:fd})}else{const text=$('#textData').value.trim();if(text.length<50)return toast('Paste at least 50 characters','error');d=await request('/api/v1/ai/drafts',{method:'POST',body:JSON.stringify({title:$('#quizTitle').value.trim()||'AI review draft',source_type:'text',source_content:text,count:Math.min(getCount(),100)})})}openAIDraftReview(d);return;state.quiz=(d.quiz||[]).map(normalizeQuestion);state.sessionId=d.session_id||null;state.mcqPrompted=false;state.retakeContext=null;saveHistoryIdentityForCurrentSession();state.activeAssignmentMeta=null;state.startedAt=Date.now();startTimer();renderQuiz();focusQuizMode(true);promptMcqDownloadOnce();toast('Quiz generated','success')}catch(e){toast(e.message||'Quiz generation failed. Nothing was saved.','error');state.quiz=[];state.sessionId=null;renderQuiz()}finally{setBusy(btn,false)}}
function normalizeQuestion(q,i){const opts=Array.isArray(q.options)?q.options.slice():[];if(q.correct&&!opts.includes(q.correct))opts.unshift(q.correct);while(opts.length<4)opts.push('Option '+(opts.length+1));return {...q,question:q.question||q.question_body||('Question '+(i+1)),correct:q.correct||opts[q.correct_index||0],options:opts.slice(0,6),difficulty:q.difficulty||'medium'}}
function renderLocalFallback(){const text=$('#textData').value.trim();if(text.length<50)return;const sentences=text.split(/[.!?]+/).map(x=>x.trim()).filter(x=>x.length>35).slice(0,Math.min(getCount(),10));state.quiz=sentences.map((s,i)=>normalizeQuestion({id:'local_'+i,question:'Which statement best matches this note: '+s.slice(0,90)+'...',correct:'The statement is supported by the notes.',options:['The statement is supported by the notes.','The statement is unrelated.','The statement is a mathematical proof.','The statement is only a heading.'],difficulty:i%3===0?'easy':i%3===1?'medium':'hard'},i));state.sessionId=null;state.mcqPrompted=false;startTimer();renderQuiz();focusQuizMode(true);promptMcqDownloadOnce();toast('Offline demo quiz shown because backend failed','error')}
function renderQuiz(){const out=$('#quizOut');if(!state.quiz.length){$('#quizToolbar').classList.add('hidden');out.innerHTML='<div class="empty"><div><h3>No quiz yet</h3><p>Generate questions first.</p></div></div>';return}$('#quizToolbar').classList.remove('hidden');const endTop=$('#endQuizTopBtn');if(endTop)endTop.classList.toggle('hidden',state.submitted);const items=state.quiz.map((q,i)=>({q,i})).filter(x=>state.filter==='all'||x.q.difficulty===state.filter);const actions=state.submitted?'<button class="btn ghost" onclick="resetAttempt()">Retake test</button><button class="btn primary" onclick="openStoredResultPop()">View Result Card</button><button class="btn ghost" onclick="createNewQuiz()">Create New Quiz</button><button class="btn ghost" onclick="showMcqDownloadPop(true)">MCQ PDF Card</button><button class="btn ghost" onclick="downloadMCQsPDF()">Download MCQs PDF</button>':'<button class="btn primary" onclick="submitQuiz()">Submit Test</button><button class="btn ghost" onclick="resetAttempt()">Reset answers</button><button class="btn ghost" onclick="createNewQuiz()">Create New Quiz</button><button class="btn ghost" onclick="showMcqDownloadPop(true)">MCQ PDF Card</button><button class="btn ghost" onclick="downloadMCQsPDF()">Download MCQs PDF</button>';out.innerHTML='<div class="quiz-list">'+items.map(({q,i})=>questionHTML(q,i)).join('')+'</div><div class="quick-actions" style="margin-top:16px">'+actions+'</div>';updateProgress();renderRevision();}
function questionHTML(q,i){const chosen=state.answered[i];let cls='question-card';if(state.submitted){cls+=' '+(chosen!=null&&q.options[chosen]===q.correct?'correct':'wrong')}return `<div class="${cls}" data-diff="${q.difficulty}"><div class="qtop"><div><div class="qnum">QUESTION ${i+1}</div><div class="qtext">${safe(q.question)}</div></div><span class="badge">${safe(q.difficulty)}</span></div>${q.options.map((op,j)=>optionHTML(q,i,op,j)).join('')}</div>`}
function optionHTML(q,i,op,j){let cls='option';if(state.answered[i]===j)cls+=' selected';if(state.submitted&&op===q.correct)cls+=' good';if(state.submitted&&state.answered[i]===j&&op!==q.correct)cls+=' bad';return `<button class="${cls}" onclick="selectAnswer(${i},${j})"><b>${String.fromCharCode(65+j)}.</b><span>${safe(op)}</span></button>`}
function selectAnswer(i,j){if(state.submitted)return;state.answered[i]=j;renderQuiz()}
function updateProgress(){const total=state.quiz.length;const answered=Object.keys(state.answered).length;$('#progressBadge').textContent=answered+'/'+total+' answered';$('#sideQuizCount').textContent=total;$('#sideAnswered').textContent=answered;$('#progressBar').style.width=total?Math.round(answered/total*100)+'%':'0%';const diff=state.quiz.reduce((a,q)=>(a[q.difficulty]=(a[q.difficulty]||0)+1,a),{});$('#quizBadges').innerHTML=['easy','medium','hard'].map(k=>`<span class="badge">${k}: ${diff[k]||0}</span>`).join('')}
function filterQuiz(f,btn){state.filter=f;$$('.filter').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderQuiz()}
async function submitQuiz(){
  if(!state.quiz.length)return;
  state.submitted=true;clearInterval(state.timer);
  let score=0;const total=state.quiz.length;
  state.quiz.forEach((q,i)=>{if(q.options[state.answered[i]]===q.correct)score++});
  const answered=Object.keys(state.answered).length;
  const wrong=state.quiz.reduce((n,q,i)=>n+(state.answered[i]!=null&&q.options[state.answered[i]]!==q.correct?1:0),0);
  const skipped=total-answered;
  const pct=Math.round(score/total*100);
  const learner=profileDetails().fullName||SESSION.username||'Student';
  const title=$('#quizTitle').value.trim()||'Practice Quiz';
  const time=$('#timerBadge').textContent||'00:00';
  const at=new Date().toLocaleString();
  const comparison=buildRetakeComparison(score,total,pct);
  $('#scorePanel').classList.add('show');
  state.lastResult={score,total,answered,wrong,skipped,pct,title,time,at,comparison};
  const compareLine=comparison?`<div class="hint" style="margin-top:8px"><b>Retake comparison:</b> Previous ${comparison.previousPct}% → Current ${comparison.currentPct}% · ${comparison.diff>0?'+':''}${comparison.diff}% (${safe(comparison.status)})</div>`:'';
  $('#scorePanel').innerHTML=`<div class="quiz-result-card"><div><div class="badge good">RESULT READY</div><h3 class="result-title">${safe(resultBand(pct))}</h3><div class="muted">${safe(learner)} · ${pct}% score · ${score}/${total} correct · ${safe(time)} · academic card generated</div>${compareLine}</div><div class="quick-actions"><button class="btn primary small" onclick="openStoredResultPop()">View Result Card</button><button class="btn ghost small" onclick="createNewQuiz()">Create New Quiz</button><button class="btn ghost small" onclick="downloadResultPDF()">Download Result PDF</button></div></div>`;
  renderQuiz();openStoredResultPop();
  if(state.sessionId){try{await request(`/api/v1/session/${state.sessionId}/attempt`,{method:'POST',body:JSON.stringify({user_id:SESSION.user_id,score,total,answers:state.answered})})}catch(e){console.warn(e)}}
  storeLocalAttempt(score,total,pct,comparison);
  saveAutoWeakQuiz(score,total,pct,answered,wrong,skipped,title,time,at);
  renderStudentDashboard();renderStats();renderHistoryAfterRetake();renderRevision();
}
function endQuizWithoutAttempt(){
  if(!state.quiz.length)return toast('No active quiz to end','error');
  if(!confirm('End this quiz without submitting a result?'))return;
  clearInterval(state.timer);
  const total=state.quiz.length,score=0,answered=0,wrong=0,skipped=total,pct=0;
  const learner=profileDetails().fullName||SESSION.username||'Student';
  const title=$('#quizTitle').value.trim()||'Practice Quiz';
  const time=$('#timerBadge').textContent||'00:00';
  const at=new Date().toLocaleString();
  state.answered={};state.submitted=true;state.lastResult={score,total,answered,wrong,skipped,pct,title,time,at,comparison:null,ended:true};
  state.mcqPrompted=false;state.retakeContext=null;state.activeAssignmentMeta=null;state.filter='all';
  $('#scorePanel')?.classList.add('show');
  $('#scorePanel').innerHTML=`<div class="quiz-result-card"><div><div class="badge warn">QUIZ ENDED</div><h3 class="result-title">0% Result Card</h3><div class="muted">${safe(learner)} · 0% score · 0/${total} correct · ${safe(time)} · ended without attempt</div></div><div class="quick-actions"><button class="btn primary small" onclick="openStoredResultPop()">View Result Card</button><button class="btn ghost small" onclick="resetAttempt()">Retake test</button><button class="btn ghost small" onclick="createNewQuiz()">Create New Quiz</button><button class="btn ghost small" onclick="downloadResultPDF()">Download Result PDF</button></div></div>`;
  renderQuiz();openStoredResultPop();renderRevision();toast('Quiz ended and 0% result card created','success')
}
function resetAttempt(){state.answered={};state.submitted=false;state.lastResult=null;$('#scorePanel').classList.remove('show');startTimer();renderQuiz();focusQuizMode(true)}
function attemptsKey(){return 'aqg_attempts_'+sessionKey()}
function sessionAttemptsKey(id){return 'aqg_session_attempts_'+sessionKey()+'_'+String(id||'local')}
function readSessionAttempts(id){return readJSON(sessionAttemptsKey(id),[])}
function latestSessionAttempt(id){const arr=readSessionAttempts(id);return arr.length?arr[arr.length-1]:null}
function formatSigned(n){return (n>0?'+':'')+n}
function retakeStatus(diff){return diff>0?'Improved from previous attempt':diff<0?'Needs review against previous attempt':'Matched previous attempt'}
function buildRetakeComparison(score,total,pct){
  const id=state.sessionId;
  if(!state.retakeContext||String(state.retakeContext.sessionId)!==String(id))return null;
  const prev=latestSessionAttempt(id)||state.retakeContext.previous;
  if(!prev||prev.pct==null||Number.isNaN(Number(prev.pct)))return null;
  const previousPct=Math.round(Number(prev.pct)),diff=pct-previousPct,status=retakeStatus(diff);
  const prevMarks=prev.score!=null&&prev.total!=null?`${prev.score}/${prev.total}`:`${previousPct}%`;
  return {sessionId:id,previousPct,currentPct:pct,diff,status,previousScore:prev.score??null,previousTotal:prev.total??null,currentScore:score,currentTotal:total,previousMarks:prevMarks,currentMarks:`${score}/${total}`,message:`Compared with the previous quiz result: ${prevMarks} → ${score}/${total} (${previousPct}% → ${pct}%).`};
}
function storeLocalAttempt(score,total,pct,comparison=null){
  const item={score,total,pct,at:new Date().toISOString(),title:$('#quizTitle').value.trim()||'Untitled quiz',sessionId:state.sessionId||null,comparison:comparison||null};
  const arr=readJSON(attemptsKey(),[]);arr.push(item);writeJSON(attemptsKey(),arr);
  if(state.sessionId){const s=readSessionAttempts(state.sessionId);s.push(item);writeJSON(sessionAttemptsKey(state.sessionId),s)}
}
function renderHistoryAfterRetake(){if($('#historyPanel')?.classList.contains('active'))renderHistory()}
function latestRetakeComparisonForSession(id){const arr=readSessionAttempts(id).filter(a=>a.comparison);return arr.length?arr[arr.length-1].comparison:null}
function historyComparisonPill(id){
  const c=latestRetakeComparisonForSession(id);
  if(!c)return '';
  const cls=c.diff>0?'good':c.diff<0?'bad':'brand';
  return `<div class="history-compare-pill ${cls}">Prev ${c.previousPct}% → Now ${c.currentPct}% · ${formatSigned(c.diff)}%</div>`;
}

function historyIdentityKey(){return 'aqg_history_identity_'+sessionKey()}
function historyIdentityMap(){return readJSON(historyIdentityKey(),{})}
function saveHistoryIdentity(id,meta){
  if(!id||!meta)return;
  const map=historyIdentityMap();
  map[String(id)]={...meta,savedAt:new Date().toISOString()};
  writeJSON(historyIdentityKey(),map);
}
function currentAssignmentHistoryMeta(){
  const a=state.activeAssignmentMeta;
  if(!a)return null;
  return {origin:'teacher',sourceLabel:'Teacher Quiz',assignmentId:a.assignmentId||a.id||null,assignmentTitle:a.assignmentTitle||a.title||$('#quizTitle')?.value?.trim()||'Assigned quiz',classCode:a.classCode||'',className:a.className||'Academic Class',teacherName:a.teacherName||'Teacher',subject:a.subject||'General',due:a.due||'',instructions:a.instructions||'',questionCount:a.count||getCount(),createdFrom:'Student assignment workspace'};
}
function saveHistoryIdentityForCurrentSession(){
  if(!state.sessionId)return;
  const teacherMeta=currentAssignmentHistoryMeta();
  if(teacherMeta){saveHistoryIdentity(state.sessionId,teacherMeta);return}
  if(!state.retakeContext){
    saveHistoryIdentity(state.sessionId,{origin:'self',sourceLabel:'Self-created Practice',assignmentTitle:$('#quizTitle')?.value?.trim()||'Practice quiz',classCode:'',className:'Own Practice',teacherName:'Self-created',subject:'Personal Study',due:'',questionCount:getCount(),createdFrom:'Generate Quiz workspace'});
  }
}
function assignmentMetaFromRowTitle(row){
  const title=String(row?.title||'').trim().toLowerCase();
  if(!title)return null;
  const rows=typeof getStudentAssignments==='function'?getStudentAssignments():[];
  const match=rows.find(a=>String(a.title||'').trim().toLowerCase()===title);
  if(!match)return null;
  const code=match.joinedClassCode||match.classCode||'';
  const meta=teacherClassMeta(code);
  return {origin:'teacher',sourceLabel:'Teacher Quiz',assignmentId:match.id||null,assignmentTitle:match.title||row.title,classCode:code,className:match.className||meta.className,teacherName:match.teacherName||meta.teacherName,subject:match.subject||meta.subject||'General',due:match.due||'',instructions:match.instructions||'',questionCount:match.count||row.total_questions||0,createdFrom:'Matched from joined teacher assignment'};
}
function historyIdentity(row){
  const id=String(row?.session_id||'');
  const saved=historyIdentityMap()[id];
  if(saved)return saved;
  if(row?.origin==='teacher'||row?.assignment_id||row?.class_code||row?.teacher_name){
    return {origin:'teacher',sourceLabel:'Teacher Quiz',assignmentId:row.assignment_id||null,assignmentTitle:row.assignment_title||row.title||'Assigned quiz',classCode:row.class_code||row.classCode||'',className:row.class_name||row.className||'Academic Class',teacherName:row.teacher_name||row.teacherName||row.teacher||'Teacher',subject:row.subject||row.quiz_type||'General',due:row.due||row.due_date||'',questionCount:row.total_questions||0,createdFrom:'Teacher class assignment'};
  }
  const matched=assignmentMetaFromRowTitle(row);
  if(matched)return matched;
  return {origin:'self',sourceLabel:'Self-created Practice',assignmentTitle:row?.title||'Practice quiz',classCode:'Personal Workspace',className:'Own Practice',teacherName:'Self-created',subject:row?.quiz_type||row?.source_type||'Personal Study',due:'Not applicable',questionCount:row?.total_questions||0,createdFrom:'Generate Quiz workspace'};
}
function historyNiceDate(v){
  if(!v)return '-';
  const d=new Date(v);
  return Number.isNaN(d.getTime())?safe(v):d.toLocaleString();
}
function historyScoreValue(r){
  if(r.last_score==null||Number.isNaN(Number(r.last_score)))return {big:'Pending',sub:'Not attempted yet',raw:null};
  const pct=Math.round(Number(r.last_score));
  return {big:pct+'%',sub:'Latest score',raw:pct};
}
function historyDueText(v){
  if(!v)return 'No due date';
  const d=new Date(v);
  return Number.isNaN(d.getTime())?String(v):d.toLocaleDateString();
}

async function loadHistory(show=true){if(!SESSION)return;const out=$('#historyOut');if(show)out.innerHTML='<div class="muted">Loading history...</div>';try{const d=await request(`/api/v1/history/${SESSION.user_id}`);state.history=d.sessions||[];renderHistory()}catch(e){if(show)out.innerHTML='<div class="notice danger-note">Could not load backend history: '+safe(e.message)+'</div>'}}
function renderHistory(){
  const rows=state.history||[];
  const out=$('#historyOut');
  if(!out)return;
  if(!rows.length){out.innerHTML='<div class="empty" style="min-height:220px"><div><h3>No history yet</h3><p>Generate a quiz or open a teacher assignment and it will appear here with full source identity.</p></div></div>';return}
  const identities=rows.map(r=>historyIdentity(r));
  const teacherCount=identities.filter(x=>x.origin==='teacher').length;
  const selfCount=rows.length-teacherCount;
  const attempted=rows.filter(r=>r.last_score!=null&&!Number.isNaN(Number(r.last_score))).length;
  const best=rows.reduce((m,r)=>r.last_score==null?m:Math.max(m,Math.round(Number(r.last_score))),0);
  out.innerHTML=`<div class="history-pro-wrap">
    <div class="history-pro-summary">
      <div><span>Total records</span><b>${rows.length}</b></div>
      <div><span>Teacher assigned</span><b>${teacherCount}</b></div>
      <div><span>Self practice</span><b>${selfCount}</b></div>
      <div><span>Best score</span><b>${best||0}%</b></div>
    </div>
    <div class="history-pro-list">${rows.map((r,idx)=>{
      const id=r.session_id;
      const meta=identities[idx];
      const score=historyScoreValue(r);
      const isTeacher=meta.origin==='teacher';
      const sourceBadge=isTeacher?'Teacher Quiz':'Self-created Quiz';
      const sourceClass=isTeacher?'teacher':'self';
      const title=r.title||meta.assignmentTitle||'Untitled quiz';
      const qCount=r.total_questions||meta.questionCount||'-';
      const sourceType=r.source_type||'text';
      const quizType=r.quiz_type||meta.subject||'General';
      const compare=latestRetakeComparisonForSession(id);
      const compareText=compare?`<span class="badge ${compare.diff>0?'good':compare.diff<0?'warn':'brand'}">Retake: ${compare.previousPct}% → ${compare.currentPct}% (${formatSigned(compare.diff)}%)</span>`:'';
      return `<div class="history-pro-card">
        <div class="history-pro-top">
          <div>
            <div class="history-origin-row"><span class="history-origin-badge ${sourceClass}">${sourceBadge}</span><span class="badge">${safe(qCount)} Questions</span><span class="badge">${safe(sourceType).toUpperCase()}</span>${compareText}</div>
            <h3 class="history-pro-title">${safe(title)}</h3>
            <div class="history-pro-sub">${isTeacher?`This quiz came from <b>${safe(meta.className)}</b> by <b>${safe(meta.teacherName)}</b>.`:'This quiz was created by you from your own Generate Quiz workspace.'}</div>
          </div>
          <div class="history-score-box"><b>${safe(score.big)}</b><span>${safe(score.sub)}</span></div>
        </div>
        <div class="history-identity-grid">
          <div><span>Quiz source</span><b>${safe(meta.sourceLabel||sourceBadge)}</b></div>
          <div><span>Quiz / assignment</span><b>${safe(meta.assignmentTitle||title)}</b></div>
          <div><span>Subject / type</span><b>${safe(meta.subject||quizType||'General')}</b></div>
          <div><span>Teacher</span><b>${safe(isTeacher?meta.teacherName:'Self-created')}</b></div>
          <div><span>Class name</span><b>${safe(isTeacher?meta.className:'Own Practice')}</b></div>
          <div><span>Class code / workspace</span><b class="mono">${safe(isTeacher?meta.classCode:'Personal')}</b></div>
          <div><span>Due date</span><b>${safe(isTeacher?historyDueText(meta.due):'Not applicable')}</b></div>
          <div><span>Created</span><b>${safe(historyNiceDate(r.created_at))}</b></div>
          <div><span>Record ID</span><b class="mono">${safe(id||'-')}</b></div>
        </div>
        <div class="history-action-row">
          <div class="history-date-text">${isTeacher?`Teacher quiz details are saved locally for this session: ${safe(meta.className)} · ${safe(meta.teacherName)} · ${safe(meta.classCode)}.`:'Own practice session with no teacher class attached.'}</div>
          <div class="quick-actions"><button class="btn primary small" onclick="retakeSession(${id})">Retake</button><button class="btn danger small" onclick="deleteSession(${id})">Delete</button></div>
        </div>
      </div>`}).join('')}</div>
  </div>`;
}
async function retakeSession(id){
  try{
    const row=(state.history||[]).find(r=>String(r.session_id)===String(id))||{};
    const d=await request(`/api/v1/session/${id}`);
    state.quiz=(d.questions||[]).map(normalizeQuestion);
    state.sessionId=id;state.answered={};state.submitted=false;state.lastResult=null;state.mcqPrompted=false;
    const title=row.title||d.title||$('#quizTitle').value.trim()||'Retake Quiz';
    if($('#quizTitle'))$('#quizTitle').value=title;
    const localPrev=latestSessionAttempt(id);
    const backendPct=row.last_score!=null?Math.round(Number(row.last_score)):null;
    const backendPrev=Number.isFinite(backendPct)?{pct:backendPct,score:null,total:row.total_questions||state.quiz.length,at:row.created_at,title}:null;
    state.retakeContext={sessionId:id,previous:localPrev||backendPrev,title};
    $('#scorePanel').classList.remove('show');
    showPanel('generatePanel');startTimer();renderQuiz();focusQuizMode(true);promptMcqDownloadOnce();
    toast(state.retakeContext.previous?'Retake opened with previous score ready for comparison':'Retake opened in full quiz view','success');
  }catch(e){toast(e.message,'error')}
}
async function deleteSession(id){if(!confirm('Delete this quiz session?'))return;try{await request(`/api/v1/session/${id}?user_id=${SESSION.user_id}`,{method:'DELETE'});toast('Deleted','success');loadHistory()}catch(e){toast(e.message,'error')}}
function renderStats(){
  const out=$('#statsOut');if(!out)return;

  /* PERFORMANCE SECTION PREMIUM REBUILD UPDATE: professional analytics render, only for Performance panel. */
  const rawAttempts=readJSON(attemptsKey(),[]);
  const backendRows=(state.history||[]).filter(r=>r&&r.last_score!=null);
  const toPct=v=>Math.max(0,Math.min(100,Math.round(Number(v)||0)));
  const niceDate=v=>{try{return v?new Date(v).toLocaleString():'Not recorded'}catch(e){return 'Not recorded'}};
  const shortDate=v=>{try{return v?new Date(v).toLocaleDateString():'-'}catch(e){return '-'}};
  const attemptRecords=rawAttempts.map((a,i)=>{
    const meta=a.sessionId?historyIdentity({session_id:a.sessionId,title:a.title,total_questions:a.total}):null;
    const isTeacher=meta&&meta.origin==='teacher';
    return {kind:'attempt',idx:i+1,title:a.title||'Untitled quiz',pct:toPct(a.pct),score:Number(a.score)||0,total:Number(a.total)||0,at:a.at||'',sessionId:a.sessionId||null,meta:meta||{origin:'self',sourceLabel:'Self-created Practice',teacherName:'Self-created',className:'Own Practice',classCode:'Personal',subject:'Personal Study'},source:isTeacher?'Teacher Quiz':'Self Practice',teacher:isTeacher?meta.teacherName:'Self-created',className:isTeacher?meta.className:'Own Practice',classCode:isTeacher?meta.classCode:'Personal',subject:isTeacher?meta.subject:'Personal Study'};
  });
  const backendRecords=backendRows.map((r,i)=>{const meta=historyIdentity(r),isTeacher=meta&&meta.origin==='teacher',pct=toPct(r.last_score);return {kind:'backend',idx:i+1,title:r.title||meta.assignmentTitle||'Saved quiz session',pct,score:null,total:Number(r.total_questions)||0,at:r.created_at||'',sessionId:r.session_id||null,meta,source:isTeacher?'Teacher Quiz':'Self Practice',teacher:isTeacher?meta.teacherName:'Self-created',className:isTeacher?meta.className:'Own Practice',classCode:isTeacher?meta.classCode:'Personal',subject:meta.subject||r.quiz_type||'General'};});
  const hasLocalSession=id=>id&&attemptRecords.some(a=>String(a.sessionId)===String(id));
  const records=[...attemptRecords,...backendRecords.filter(r=>!hasLocalSession(r.sessionId))].sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));
  const recent=[...records].sort((a,b)=>new Date(b.at||0)-new Date(a.at||0));
  const total=records.length;
  const avg=total?Math.round(records.reduce((s,a)=>s+a.pct,0)/total):0;
  const best=total?Math.max(...records.map(a=>a.pct)):0;
  const latest=recent[0]||null;
  const previous=recent[1]||null;
  const trend=latest&&previous?latest.pct-previous.pct:0;
  const teacherCount=records.filter(a=>a.meta?.origin==='teacher').length;
  const selfCount=Math.max(0,total-teacherCount);
  const totalMarks=attemptRecords.reduce((s,a)=>s+(Number(a.total)||0),0);
  const correctMarks=attemptRecords.reduce((s,a)=>s+(Number(a.score)||0),0);
  const accuracy=totalMarks?Math.round(correctMarks/totalMarks*100):avg;
  const d=profileDetails();
  const readyKeys=['fullName','academicId','institute','department','class','email'];
  const ready=readyKeys.filter(k=>String(k==='email'?(d.email||SESSION?.email||''):(d[k]||'')).trim()).length;
  const profilePct=Math.round(ready/readyKeys.length*100);
  const trendText=!latest?'No attempts yet':trend>0?`Improved ${formatSigned(trend)}% from last attempt`:trend<0?`${formatSigned(trend)}% below previous attempt`:'Matched previous attempt';
  const status=avg>=85?'Excellent':avg>=70?'Strong':avg>=50?'Improving':total?'Needs focus':'New learner';
  const teacherW=total?Math.round(teacherCount/total*100):0,selfW=total?100-teacherW:0;
  const chartRecords=records.slice(-10);
  const chartHTML=chartRecords.length?chartRecords.map((a,i)=>`<div class="perf-bar" title="${safe(a.title)} · ${a.pct}%"><div class="perf-bar-fill" style="--h:${a.pct}"></div><b>${i+1}</b></div>`).join(''):`<div class="perf-empty" style="min-height:188px;width:100%"><div><h3>No score timeline yet</h3><p>Create or attempt a quiz to build your performance graph.</p></div></div>`;
  const recHTML=recent.slice(0,8).map(a=>`<div class="perf-record"><div><span>${safe(a.source)} · ${safe(a.subject||'General')}</span><h3>${safe(a.title)}</h3><p>${safe(a.className)} · ${safe(a.teacher)} · ${safe(shortDate(a.at))}</p></div><div class="perf-record-score"><b>${a.pct}%</b><small>${a.score!=null?`${a.score}/${a.total}`:`${a.total||0} Qs`}</small></div></div>`).join('')||`<div class="perf-empty"><div><h3>No attempts recorded</h3><p>Your performance records will appear here after your first submitted quiz.</p><div class="quick-actions" style="justify-content:center;margin-top:12px"><button class="btn primary small" onclick="showPanel('generatePanel')">Create first quiz</button></div></div></div>`;
  const profileHTML=[['Student',d.fullName||SESSION?.username||'Student'],['Roll / ID',d.academicId||'Not added'],['Institute',d.institute||'Not added'],['Class / Semester',d.class||'Not added'],['Department',d.department||'Not added'],['Profile ready',profilePct+'%']].map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('');
  const plan=avg>=85?
    [['Maintain mastery','Retake only weak or skipped questions once a week.'],['Keep proof ready','Download result PDFs for strong academic records.'],['Push challenge level','Generate harder MCQs from advanced notes.']]:
    avg>=70?
    [['Review mistakes','Read the answer review and revise every wrong answer.'],['Retake strategically','Retake the same quiz after revision and compare scores.'],['Build consistency','Attempt one mixed quiz after each chapter.']]:
    total?
    [['Fix weak concepts','Start from wrong and skipped answers before new quizzes.'],['Use short practice','Generate 10-question tests until average improves.'],['Track improvement','Use retake comparison after every review cycle.']]:
    [['Start clean','Create your first quiz from notes or PDF.'],['Attempt fully','Submit the test to unlock performance analytics.'],['Review history','Use History & Review after each quiz.']];
  const planHTML=plan.map((p,i)=>`<div class="perf-plan-item"><div class="perf-plan-num">${i+1}</div><div><b>${safe(p[0])}</b><small>${safe(p[1])}</small></div></div>`).join('');
  out.innerHTML=`<div class="perf-pro-wrap">
    <div class="perf-pro-hero">
      <div><span class="badge brand">ACADEMIC PERFORMANCE CENTER</span><h2>Performance Overview</h2><p>Track your quiz records, average score, latest attempt, and improvement focus in one clean view.</p><div class="perf-hero-chips"><span class="badge ${total?'good':'warn'}">${safe(status)}</span><span class="badge">Latest: ${latest?latest.pct+'%':'No attempt'}</span><span class="badge">${safe(trendText)}</span></div></div>
      <div class="perf-score-orb" style="--p:${avg}"><div><div><b>${avg}%</b><span>Average score</span></div></div></div>
    </div>
    <div class="perf-kpi-grid">
      <div class="perf-kpi"><span>Total Records</span><b>${total}</b><small>Local attempts + saved sessions</small></div>
      <div class="perf-kpi"><span>Best Score</span><b>${best}%</b><small>Highest recorded performance</small></div>
      <div class="perf-kpi"><span>Latest Score</span><b>${latest?latest.pct+'%':'0%'}</b><small>${latest?safe(shortDate(latest.at)):'No submitted quiz yet'}</small></div>
      <div class="perf-kpi"><span>Accuracy</span><b>${accuracy}%</b><small>${totalMarks?`${correctMarks}/${totalMarks} correct answers`:'Based on available scores'}</small></div>
      <div class="perf-kpi"><span>Teacher Work</span><b>${teacherCount}</b><small>Assigned/classroom records</small></div>
      <div class="perf-kpi"><span>Self Practice</span><b>${selfCount}</b><small>Own generated quiz records</small></div>
    </div>
    <div class="perf-main-grid">
      <div class="perf-left-stack">
        <div class="perf-panel"><div class="perf-panel-head"><div><div class="perf-panel-title">Score trend timeline</div><p>Last ${chartRecords.length||0} academic records shown from oldest to newest.</p></div><span class="badge brand">Trend ${formatSigned(trend)}%</span></div><div class="perf-chart">${chartHTML}</div></div>
        <div class="perf-panel"><div class="perf-panel-head"><div><div class="perf-panel-title">Recent academic attempts</div><p>Every row shows quiz title, source, class/teacher identity, marks, and date.</p></div><span class="badge">${recent.length} records</span></div><div class="perf-record-list">${recHTML}</div></div>
      </div>
      <div class="perf-side-stack">
        <div class="perf-panel"><div class="perf-panel-head"><div><div class="perf-panel-title">Student snapshot</div><p>Profile readiness and academic identity used for result records.</p></div><span class="badge ${profilePct>=80?'good':'warn'}">${profilePct}% ready</span></div><div class="perf-profile-grid">${profileHTML}</div></div>
        <div class="perf-panel"><div class="perf-panel-head"><div><div class="perf-panel-title">Practice source split</div><p>Shows how much work came from teacher assignments versus self practice.</p></div></div><div class="perf-source-bars"><div class="perf-source-line"><div class="perf-source-top"><b>Teacher quizzes</b><span>${teacherCount} · ${teacherW}%</span></div><div class="perf-source-track"><div style="--w:${teacherW}"></div></div></div><div class="perf-source-line"><div class="perf-source-top"><b>Self practice</b><span>${selfCount} · ${selfW}%</span></div><div class="perf-source-track"><div style="--w:${selfW}"></div></div></div></div></div>
        <div class="perf-panel"><div class="perf-panel-head"><div><div class="perf-panel-title">Focused improvement plan</div><p>Smart next steps based on your current average.</p></div></div><div class="perf-plan">${planHTML}</div></div>
      </div>
    </div>
  </div>`;
}
function renderStudentDashboard(){if(!SESSION)return;const attempts=readJSON(attemptsKey(),[]),assignments=getStudentAssignments(),studentClasses=(typeof studentClassRows==='function'?studentClassRows():[]),best=attempts.length?Math.max(...attempts.map(a=>a.pct)):0,avg=attempts.length?Math.round(attempts.reduce((s,a)=>s+a.pct,0)/attempts.length):0,d=profileDetails();$('#sdSessions').textContent=Math.max(state.history.length||0,attempts.length||0);$('#sdBest').textContent=best+'%';$('#sdAssignments').textContent=studentClasses.length||assignments.length;$('#sdReady').textContent=best>=85?'Excellent':best>=70?'Strong':best>=50?'Improving':attempts.length?'Needs focus':'New';const box=$('#studentAcademicBox');if(box){const rows=[['Student',d.fullName||SESSION.username||'Student'],['Roll / ID',d.academicId||'Not added'],['Institute',d.institute||'Not added'],['Department',d.department||'Not added'],['Class / Semester',d.class||'Not added'],['Email',d.email||SESSION.email||'Not added']];box.innerHTML=rows.map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}const focus=$('#studentFocusBox');if(focus)focus.innerHTML=[['Next action',attempts.length?'Review weak questions and retake your last quiz':'Create your first MCQ practice quiz'],['Study pack','Download MCQs PDF before attempting for offline revision'],['Performance',attempts.length?`Average score ${avg}% across ${attempts.length} attempt${attempts.length>1?'s':''}`:'No attempt recorded yet']].map(r=>`<div class="dash-step"><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}
function profileKey(){return 'aqg_profile_'+sessionKey()}
function profileDetails(){return readJSON(profileKey(),{})}
function updateProfileMini(){const d=profileDetails();const n=$('#profileMiniName'),r=$('#profileMiniRole'),p=$('#profileMiniPhone');if(n)n.textContent=d.fullName||SESSION?.username||'Clean account';if(r)r.textContent=getRole()==='teacher'?'Teacher':'Student';if(p)p.textContent=d.phone||'Not added'}
function loadProfile(render=true){if(!SESSION)return;paintUser();const d=profileDetails();['fullName','fatherName','email','institute','department','class','academicId','phone','bio'].forEach(k=>{const el=$('#pd_'+(k==='class'?'class':k));if(el)el.value=k==='email'?(d.email||SESSION.email||''):(d[k]||'')});$('#profileRoleTitle').textContent=getRole()==='teacher'?'Teacher academic details':'Student academic details';$('#pd_id_label').textContent=getRole()==='teacher'?'Employee ID / Teacher code':'Roll no / student ID';updateProfileMini();bindAvatar();if(render)toast('Profile loaded','success')}
function saveProfileDetails(){const d={...profileDetails(),fullName:$('#pd_fullName').value.trim(),fatherName:$('#pd_fatherName').value.trim(),email:$('#pd_email').value.trim(),institute:$('#pd_institute').value.trim(),department:$('#pd_department').value.trim(),class:$('#pd_class').value.trim(),academicId:$('#pd_academicId').value.trim(),phone:$('#pd_phone').value.trim(),bio:$('#pd_bio').value.trim()};writeJSON(profileKey(),d);paintUser();updateProfileMini();renderStudentDashboard();renderTeacherDashboard();toast('Profile saved','success')}


/*
  TEACHER PROFILE JS UPDATE:
  Teacher profile has separate form IDs but saves into the same current-account profile record.
*/


function updateTeacherProfileMini(){const d=profileDetails();const set=(id,val)=>{const el=$(id);if(el)el.textContent=val};set('#teacherMiniName',d.fullName||SESSION?.username||'Teacher profile');set('#teacherMiniEmail',d.email||SESSION?.email||'No email');set('#teacherMiniPhone',d.phone||'Not added');set('#teacherMiniSubject',d.teacherSubject||'Not added');set('#teacherMiniQualification',d.qualification||'Not added');set('#teacherMiniClass',d.class||'Not added');set('#teacherMiniId',d.academicId||'Not added');set('#teacherMiniCode',d.teacherAccessCode||d.teacherCode||d.classCode||'Not generated');const completeKeys=['fullName','email','phone','institute','department','designation','qualification','teacherSubject','class','academicId'];const done=completeKeys.filter(k=>String(k==='email'?(d.email||SESSION?.email||''):(d[k]||'')).trim()).length;const pct=Math.round(done/completeKeys.length*100);set('#teacherMiniComplete',pct+'% ready');const meter=$('#teacherMiniMeter');if(meter)meter.style.width=pct+'%'}
function loadTeacherProfile(render=true){if(!SESSION)return;paintUser();const d=profileDetails();const keys=['fullName','fatherName','email','phone','institute','department','designation','qualification','teacherSubject','class','academicId','bio'];keys.forEach(k=>{const el=$('#tpd_'+(k==='class'?'class':k));if(el)el.value=k==='email'?(d.email||SESSION.email||''):(d[k]||'')});updateTeacherProfileMini();bindTeacherAvatar();if(render)toast('Teacher profile loaded','success')}
function saveTeacherProfileDetails(){const d={...profileDetails(),fullName:$('#tpd_fullName').value.trim(),fatherName:$('#tpd_fatherName').value.trim(),email:$('#tpd_email').value.trim(),phone:$('#tpd_phone').value.trim(),institute:$('#tpd_institute').value.trim(),department:$('#tpd_department').value.trim(),designation:$('#tpd_designation').value.trim(),qualification:$('#tpd_qualification').value.trim(),teacherSubject:$('#tpd_teacherSubject').value.trim(),class:$('#tpd_class').value.trim(),academicId:$('#tpd_academicId').value.trim(),bio:$('#tpd_bio').value.trim()};writeJSON(profileKey(),d);updateTeacherClassDirectory(d.classCode||teacherCode());paintUser();updateTeacherProfileMini();renderTeacherDashboard();toast('Teacher profile saved','success')}
function bindTeacherAvatar(){const input=$('#teacherAvatarInput');if(!input||input.dataset.bound)return;if(input)input.dataset.bound='1';input.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(!f.type.startsWith('image/'))return toast('Select an image file','error');if(f.size>950000)return toast('Image should be under 1MB','error');const reader=new FileReader();reader.onload=async()=>{SESSION.avatar_b64=reader.result;persistSession();try{await request(`/api/v1/user/${SESSION.user_id}/profile`,{method:'PATCH',body:JSON.stringify({avatar_b64:reader.result})})}catch(e){console.warn(e)}paintUser();updateTeacherProfileMini();toast('Teacher photo updated','success')};reader.readAsDataURL(f)})}
async function clearTeacherAvatar(){await clearAvatar();updateTeacherProfileMini()}
function bindAvatar(){const input=$('#avatarInput');if(input.dataset.bound)return;input.dataset.bound='1';input.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(!f.type.startsWith('image/'))return toast('Select an image file','error');if(f.size>950000)return toast('Image should be under 1MB','error');const reader=new FileReader();reader.onload=async()=>{SESSION.avatar_b64=reader.result;persistSession();try{await request(`/api/v1/user/${SESSION.user_id}/profile`,{method:'PATCH',body:JSON.stringify({avatar_b64:reader.result})})}catch(e){console.warn(e)}paintUser();toast('Avatar updated','success')};reader.readAsDataURL(f)})}
async function clearAvatar(){SESSION.avatar_b64=null;persistSession();try{await request(`/api/v1/user/${SESSION.user_id}/profile`,{method:'PATCH',body:JSON.stringify({avatar_b64:''})})}catch(e){}paintUser();toast('Avatar removed','success')}
function openProfileModal(){$('#editUsername').value=SESSION.username||'';$('#editEmail').value=SESSION.email||'';$('#profileModal').classList.add('show')}
function closeProfileModal(){$('#profileModal').classList.remove('show')}
async function saveAccountBasics(){try{const d=await request(`/api/v1/user/${SESSION.user_id}/profile`,{method:'PATCH',body:JSON.stringify({username:$('#editUsername').value.trim(),email:$('#editEmail').value.trim()})});SESSION={...SESSION,...d};persistSession();paintUser();closeProfileModal();toast('Account updated','success')}catch(e){toast(e.message,'error')}}
async function changePassword(){try{await request(`/api/v1/user/${SESSION.user_id}/change-password`,{method:'POST',body:JSON.stringify({current_password:$('#oldPass').value,new_password:$('#newPass').value})});toast('Password changed. Sign in again.','success');setTimeout(()=>logout(),500)}catch(e){toast(e.message,'error')}}

function teacherMasterDirectoryKey(){return 'aqg_teacher_master_directory'}
function assignmentsKey(){return 'aqg_assignments_'+sessionKey()}
function classAssignmentsKey(code){return 'aqg_class_assignments_'+String(code||'').toUpperCase()}
function classDirectoryKey(){return 'aqg_teacher_class_directory'}
function teacherClassesKey(){return 'aqg_teacher_classes_'+sessionKey()}
function studentsKey(code){return 'aqg_class_students_'+String(code||'').toUpperCase()}
function classNameFromProfile(d){return d.class||d.className||(d.teacherSubject?d.teacherSubject+' Class':'Academic Class')}
function makeTeacherCode(){const base=(SESSION?.username||'TCH').replace(/[^a-z0-9]/gi,'').slice(0,3).toUpperCase()||'TCH';return 'TCH-'+base+'-'+Math.random().toString(36).slice(2,6).toUpperCase()}
function makeClassCode(){return 'CLS-'+Math.random().toString(36).slice(2,7).toUpperCase()}
function makeClassKey(){return Math.random().toString(36).slice(2,6).toUpperCase()}
function teacherCode(){let d=profileDetails();if(!d.teacherAccessCode){d.teacherAccessCode=d.teacherCode||(d.classCode&&String(d.classCode).startsWith('TCH-')?d.classCode:'')||makeTeacherCode();writeJSON(profileKey(),d)}return String(d.teacherAccessCode).toUpperCase()}
function normalizeTeacherClass(c={},d=profileDetails()){
  const code=String(c.code||c.classCode||makeClassCode()).toUpperCase();
  const teacherInvite=String(c.teacherCode||teacherCode()).toUpperCase();
  const allowedStudents=Array.isArray(c.allowedStudents)?c.allowedStudents.map(x=>String(x).trim().toUpperCase()).filter(Boolean):[];
  const allowedEmails=Array.isArray(c.allowedEmails)?c.allowedEmails.map(x=>String(x).trim().toLowerCase()).filter(Boolean):[];
  return {id:c.id||Date.now()+Math.floor(Math.random()*999),teacherCode:teacherInvite,code,classCode:code,className:c.className||c.name||classNameFromProfile(d),subject:c.subject||d.teacherSubject||'General',section:c.section||d.class||'',classKey:String(c.classKey||c.pin||makeClassKey()).toUpperCase(),allowedStudents:[...new Set(allowedStudents)],allowedEmails:[...new Set(allowedEmails)],createdAt:c.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()}
}
function ensureTeacherClasses(){
  if(!SESSION||getRole()!=='teacher')return [];
  const d=profileDetails();
  let arr=readJSON(teacherClassesKey(),[]);
  if(!Array.isArray(arr))arr=[];
  if(!arr.length){
    const oldCode=(d.classCode&&String(d.classCode).startsWith('CLS-'))?String(d.classCode).toUpperCase():'';
    arr=[normalizeTeacherClass({code:oldCode||makeClassCode(),className:classNameFromProfile(d),subject:d.teacherSubject||'General',section:d.class||'',teacherCode:teacherCode()},d)];
  }else arr=arr.map(c=>normalizeTeacherClass(c,d));
  writeJSON(teacherClassesKey(),arr);
  let nd=profileDetails();
  if(!arr.some(c=>c.code===nd.activeClassCode)){nd.activeClassCode=arr[0]?.code||'';writeJSON(profileKey(),nd)}
  publishTeacherDirectory(arr);
  return arr;
}
function publishTeacherDirectory(classes){
  if(!SESSION||getRole()!=='teacher')return;
  const d=profileDetails(),tcode=teacherCode(),arr=(classes||readJSON(teacherClassesKey(),[])).map(c=>normalizeTeacherClass(c,d));
  const dir=readJSON(classDirectoryKey(),{}),tdir=readJSON(teacherMasterDirectoryKey(),{});
  arr.forEach(c=>{dir[c.code]={...c,teacherCode:tcode,teacherName:d.fullName||SESSION.username||'Teacher',teacherEmail:d.email||SESSION.email||'',institute:d.institute||'',department:d.department||''}});
  tdir[tcode]={teacherCode:tcode,teacherName:d.fullName||SESSION.username||'Teacher',teacherEmail:d.email||SESSION.email||'',institute:d.institute||'',department:d.department||'',subject:d.teacherSubject||'General',classes:arr.map(c=>({code:c.code,className:c.className,subject:c.subject,section:c.section,classKey:c.classKey,allowedStudents:c.allowedStudents||[],allowedEmails:c.allowedEmails||[]})),updatedAt:new Date().toISOString()};
  writeJSON(classDirectoryKey(),dir);writeJSON(teacherMasterDirectoryKey(),tdir);
}
function updateTeacherClassDirectory(code){if(!SESSION||getRole()!=='teacher')return;publishTeacherDirectory(ensureTeacherClasses())}
function activeTeacherClassCode(){const arr=ensureTeacherClasses();const d=profileDetails();return (arr.find(c=>c.code===d.activeClassCode)||arr[0]||{}).code||''}
function setActiveTeacherClass(code){const arr=ensureTeacherClasses(),target=arr.find(c=>c.code===String(code||'').toUpperCase());if(!target)return;const d={...profileDetails(),activeClassCode:target.code};writeJSON(profileKey(),d);publishTeacherDirectory(arr);renderTeacherDashboard();renderTeacherClassSelect();renderTeacherStudents();toast('Active class set: '+target.className,'success')}
function teacherClassMeta(code){
  const classCode=String(code||'').trim().toUpperCase();
  const d=profileDetails();
  const local=(readJSON(teacherClassesKey(),[])||[]).find(c=>String(c.code).toUpperCase()===classCode);
  const dir=readJSON(classDirectoryKey(),{}),arr=readJSON(classAssignmentsKey(classCode),[]),a=arr[0]||{},m=dir[classCode]||local||{};
  return {code:classCode||m.code||a.classCode||'Class',className:m.className||a.className||a.classTitle||'Academic Class',teacherCode:m.teacherCode||a.teacherCode||'',teacherName:m.teacherName||a.teacherName||'Teacher',teacherEmail:m.teacherEmail||'',subject:m.subject||a.teacherSubject||a.subject||'General',section:m.section||'',classKey:m.classKey||'',allowedStudents:m.allowedStudents||[],allowedEmails:m.allowedEmails||[],institute:m.institute||a.teacherInstitute||'',department:m.department||a.teacherDepartment||''}
}
function generateTeacherCode(){const code=teacherCode();ensureTeacherClasses();navigator.clipboard?.writeText(code);paintUser();renderTeacherDashboard();toast('Teacher invite code copied: '+code,'success')}
function renderTeacherClassSelect(){const sel=$('#taClassSelect');if(!sel)return;const arr=ensureTeacherClasses();const active=activeTeacherClassCode();sel.innerHTML=arr.map(c=>`<option value="${safe(c.code)}" ${c.code===active?'selected':''}>${safe(c.className)} · ${safe(c.code)}</option>`).join('');sel.onchange=()=>{const d={...profileDetails(),activeClassCode:sel.value};writeJSON(profileKey(),d);const m=teacherClassMeta(sel.value);const key=$('#taClassKeyView');if(key)key.value=m.classKey||''};const m=teacherClassMeta(sel.value||active);const key=$('#taClassKeyView');if(key)key.value=m.classKey||''}
function createTeacherClass(){const d=profileDetails(),name=($('#tcName')?.value||'').trim(),subject=($('#tcSubject')?.value||d.teacherSubject||'General').trim(),section=($('#tcSection')?.value||'').trim(),key=($('#tcKey')?.value||'').trim().toUpperCase();if(!name)return toast('Enter class name','error');let arr=ensureTeacherClasses();const c=normalizeTeacherClass({className:name,subject,section,classKey:key||makeClassKey(),teacherCode:teacherCode()},d);arr.push(c);writeJSON(teacherClassesKey(),arr);writeJSON(profileKey(),{...profileDetails(),activeClassCode:c.code});publishTeacherDirectory(arr);['#tcName','#tcSubject','#tcSection','#tcKey'].forEach(id=>{const el=$(id);if(el)el.value=''});renderTeacherStudents();renderTeacherDashboard();renderTeacherClassSelect();toast('Class created: '+c.className,'success')}
function deleteTeacherClass(code){code=String(code||'').toUpperCase();let arr=ensureTeacherClasses();if(arr.length<=1)return toast('Keep at least one class','error');if(!confirm('Delete this class from teacher workspace? Existing student local data will remain but class will not be listed for new joins.'))return;arr=arr.filter(c=>c.code!==code);writeJSON(teacherClassesKey(),arr);writeJSON(profileKey(),{...profileDetails(),activeClassCode:arr[0]?.code||''});publishTeacherDirectory(arr);renderTeacherStudents();renderTeacherDashboard();renderTeacherClassSelect();toast('Class removed','success')}
function addAllowedStudents(code){code=String(code||'').toUpperCase();const inp=$('#allow_'+code),raw=(inp?.value||'').trim();if(!raw)return toast('Add student codes or emails','error');let arr=ensureTeacherClasses();const c=arr.find(x=>x.code===code);if(!c)return;const tokens=raw.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean);tokens.forEach(t=>{if(t.includes('@'))c.allowedEmails=[...new Set([...(c.allowedEmails||[]),t.toLowerCase()])];else c.allowedStudents=[...new Set([...(c.allowedStudents||[]),t.toUpperCase()])]});writeJSON(teacherClassesKey(),arr);publishTeacherDirectory(arr);if(inp)inp.value='';renderTeacherStudents();toast('Student approved for this class','success')}
function removeAllowedStudent(code,val){code=String(code||'').toUpperCase();const v=String(val||'');let arr=ensureTeacherClasses();const c=arr.find(x=>x.code===code);if(!c)return;c.allowedStudents=(c.allowedStudents||[]).filter(x=>x!==v.toUpperCase());c.allowedEmails=(c.allowedEmails||[]).filter(x=>x!==v.toLowerCase());writeJSON(teacherClassesKey(),arr);publishTeacherDirectory(arr);renderTeacherStudents();toast('Student approval removed','success')}
function createAssignment(){const arr=ensureTeacherClasses();const selected=String($('#taClassSelect')?.value||activeTeacherClassCode()).toUpperCase();const cls=arr.find(c=>c.code===selected)||arr[0];if(!cls)return toast('Create a class first','error');const content=$('#taContent').value.trim();if(content.length<50)return toast('Add at least 50 characters of source content','error');publishTeacherDirectory(arr);const meta=teacherClassMeta(cls.code),d=profileDetails();const a={id:Date.now(),teacherId:SESSION.user_id,teacherCode:teacherCode(),teacherName:meta.teacherName||d.fullName||SESSION.username,classCode:cls.code,className:cls.className,teacherSubject:d.teacherSubject||meta.subject||'General',teacherInstitute:d.institute||'',teacherDepartment:d.department||'',title:$('#taTitle').value.trim()||'Untitled quiz',subject:$('#taSubject').value.trim()||cls.subject||d.teacherSubject||'General',due:$('#taDue').value,instructions:$('#taInstructions').value.trim(),count:Math.max(1,Math.min(250,parseInt($('#taCount').value||10,10))),content,createdAt:new Date().toISOString()};const mine=readJSON(assignmentsKey(),[]);mine.push(a);writeJSON(assignmentsKey(),mine);const classRows=readJSON(classAssignmentsKey(cls.code),[]);classRows.push(a);writeJSON(classAssignmentsKey(cls.code),classRows);renderTeacherAssignments();renderTeacherDashboard();toast('Assignment saved for '+a.className+' · '+a.classCode,'success');showPanel('teacherAssignmentsPanel')}
function renderTeacherDashboard(){if(!SESSION||getRole()!=='teacher')return;const tcode=teacherCode(),classes=ensureTeacherClasses(),as=readJSON(assignmentsKey(),[]),studentsTotal=classes.reduce((n,c)=>n+readJSON(studentsKey(c.code),[]).length,0),active=teacherClassMeta(activeTeacherClassCode()),d=profileDetails(),keys=['fullName','email','institute','department','designation','qualification','teacherSubject','class','academicId'],done=keys.filter(k=>String(k==='email'?(d.email||SESSION.email||''):(d[k]||'')).trim()).length,ready=Math.round(done/keys.length*100);$('#tdCode').textContent=tcode;$('#tdAssignments').textContent=as.length;$('#tdStudents').textContent=studentsTotal;$('#tdAvg').textContent=ready+'%';const box=$('#teacherAcademicBox');if(box){const rows=[['Teacher',d.fullName||SESSION.username||'Teacher'],['Active class',active.className||'Academic Class'],['Total classes',classes.length],['Institute',d.institute||'Not added'],['Subject',d.teacherSubject||'Not added'],['Employee ID',d.academicId||'Not added']];box.innerHTML=rows.map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}const wf=$('#teacherWorkflowBox');if(wf)wf.innerHTML=[['Teacher invite code',tcode],['Active class key',active.classKey||'-'],['Classes',classes.length?`${classes.length} class${classes.length>1?'es':''} created`:'Create first class'],['Enrollment',studentsTotal?`${studentsTotal} joined across classes`:'Add student keys or share class keys']].map(r=>`<div class="dash-step"><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('');renderTeacherClassSelect()}
function renderTeacherAssignments(){const out=$('#teacherAssignmentsOut');if(!out)return;ensureTeacherClasses();const rows=readJSON(assignmentsKey(),[]).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));out.innerHTML=rows.length?rows.map(a=>{const meta=teacherClassMeta(a.classCode),className=a.className||meta.className,teacher=a.teacherName||meta.teacherName,code=a.classCode||meta.code;return `<div class="assignment"><div><span class="assignment-class-title">${safe(className)} · ${safe(code)}</span><h3>${safe(a.title)}</h3><p>${safe(a.subject)} · ${a.count} questions · Teacher: ${safe(teacher)}</p><div class="assignment-pro-meta"><span class="badge brand">Class: ${safe(className)}</span><span class="badge">Code: ${safe(code)}</span><span class="badge">Due: ${safe(a.due||'No due date')}</span></div><div class="hint">${safe(a.instructions||'No extra instructions')}</div></div><div class="quick-actions"><button class="btn ghost small" onclick="previewAssignment(${a.id})">Preview</button><button class="btn danger small" onclick="deleteAssignment(${a.id})">Delete</button></div></div>`}).join(''):'<div class="empty" style="min-height:220px"><div><h3>No assessments yet</h3><p>Create your first teacher assignment and select the class before publishing.</p></div></div>'}
function previewAssignment(id){const a=readJSON(assignmentsKey(),[]).find(x=>String(x.id)===String(id));if(!a)return;showPanel('teacherQuizPanel');renderTeacherClassSelect();const sel=$('#taClassSelect');if(sel&&a.classCode){sel.value=a.classCode;sel.dispatchEvent(new Event('change'))}$('#teacherPreviewBox').innerHTML=`<div class="timeline-item"><b>${safe(a.title)}</b><div class="hint">${safe((a.content||'').slice(0,300))}...</div></div>`}
function deleteAssignment(id){const a=readJSON(assignmentsKey(),[]).find(x=>String(x.id)===String(id));const code=a?.classCode;writeJSON(assignmentsKey(),readJSON(assignmentsKey(),[]).filter(x=>String(x.id)!==String(id)));if(code)writeJSON(classAssignmentsKey(code),readJSON(classAssignmentsKey(code),[]).filter(x=>String(x.id)!==String(id)));renderTeacherAssignments();renderTeacherDashboard();toast('Assignment deleted','success')}
function studentAccessCode(){let d=profileDetails();if(!d.studentJoinCode){const base=(SESSION?.username||'STD').replace(/[^a-z0-9]/gi,'').slice(0,3).toUpperCase()||'STD';d.studentJoinCode='STD-'+base+'-'+Math.random().toString(36).slice(2,6).toUpperCase();writeJSON(profileKey(),d)}return d.studentJoinCode}
function studentJoinedCodes(){const d=profileDetails(),raw=[];if(Array.isArray(d.classCodes))raw.push(...d.classCodes);if(Array.isArray(d.studentClasses))raw.push(...d.studentClasses);if(d.classCode)raw.push(d.classCode);return [...new Set(raw.map(x=>String(x||'').trim().toUpperCase()).filter(x=>x&&x!==studentAccessCode()&&!x.startsWith('STD-')&&!x.startsWith('TCH-')))]}
function saveStudentJoinedCodes(list){const clean=[...new Set((list||[]).map(x=>String(x||'').trim().toUpperCase()).filter(x=>x&&x.startsWith('CLS-')))],d={...profileDetails(),classCodes:clean,studentClasses:clean,classCode:clean[0]||''};writeJSON(profileKey(),d)}
function copyStudentCode(){const code=studentAccessCode();if(navigator.clipboard)navigator.clipboard.writeText(code);toast('Student reference code copied','success')}
function normalizeStudentApprovalKey(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,'')}
function classRecordToStudentView(c={},teacher={}){
  const code=String(c.code||c.classCode||'').trim().toUpperCase();
  return {code,classCode:code,teacherCode:String(c.teacherCode||teacher.teacherCode||'').trim().toUpperCase(),teacherName:c.teacherName||teacher.teacherName||'Teacher',teacherEmail:c.teacherEmail||teacher.teacherEmail||'',className:c.className||c.name||'Academic Class',subject:c.subject||teacher.subject||'General',section:c.section||'',classKey:String(c.classKey||c.pin||'').trim().toUpperCase(),allowedStudents:[...new Set((c.allowedStudents||[]).map(normalizeStudentApprovalKey).filter(Boolean))],allowedEmails:[...new Set((c.allowedEmails||[]).map(x=>String(x||'').trim().toLowerCase()).filter(Boolean))],institute:c.institute||teacher.institute||'',department:c.department||teacher.department||''}
}
function mergeClassRows(rows){const map=new Map();(rows||[]).forEach(c=>{const item=classRecordToStudentView(c);if(item.code&&!map.has(item.code))map.set(item.code,item)});return [...map.values()]}
function collectClassesByTeacherCode(tcode){
  const q=String(tcode||'').trim().toUpperCase(),rows=[];
  if(!q)return rows;
  const cdir=readJSON(classDirectoryKey(),{});
  Object.values(cdir||{}).forEach(c=>{if(String(c?.teacherCode||'').toUpperCase()===q)rows.push(classRecordToStudentView(c,c))});
  const tdir=readJSON(teacherMasterDirectoryKey(),{}),t=tdir[q];
  if(t&&(t.classes||[]).length)(t.classes||[]).forEach(c=>rows.push(classRecordToStudentView({...c,teacherCode:q},t)));
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i)||'';
      if(!k.startsWith('aqg_teacher_classes_'))continue;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(k)||'[]')}catch(e){arr=[]}
      if(!Array.isArray(arr))continue;
      arr.forEach(c=>{const item=classRecordToStudentView(c,c);if(item.teacherCode===q)rows.push(item)})
    }
  }catch(e){}
  return mergeClassRows(rows)
}
function classDirectoryRecord(code){
  const q=String(code||'').trim().toUpperCase();
  if(!q)return null;
  const cdir=readJSON(classDirectoryKey(),{});
  if(cdir[q])return classRecordToStudentView(cdir[q],cdir[q]);
  const tdir=readJSON(teacherMasterDirectoryKey(),{});
  for(const tcode in tdir){
    const t=tdir[tcode]||{};
    const found=(t.classes||[]).find(c=>String(c.code||c.classCode||'').toUpperCase()===q);
    if(found)return classRecordToStudentView({...found,teacherCode:tcode},t)
  }
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i)||'';
      if(!k.startsWith('aqg_teacher_classes_'))continue;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(k)||'[]')}catch(e){arr=[]}
      if(!Array.isArray(arr))continue;
      const found=arr.find(c=>String(c.code||c.classCode||'').toUpperCase()===q);
      if(found)return classRecordToStudentView(found,found)
    }
  }catch(e){}
  return null
}
function teacherByInvite(code){
  const q=String(code||'').trim().toUpperCase();
  if(!q)return null;
  const tdir=readJSON(teacherMasterDirectoryKey(),{});
  if(tdir[q]){
    const t=tdir[q],classes=mergeClassRows([...(t.classes||[]).map(c=>classRecordToStudentView({...c,teacherCode:q},t)),...collectClassesByTeacherCode(q)]);
    return {...t,teacherCode:q,classes}
  }
  const cls=classDirectoryRecord(q);
  if(cls&&cls.teacherCode){
    const t=tdir[cls.teacherCode]||{};
    const classes=mergeClassRows([...(t.classes||[]).map(c=>classRecordToStudentView({...c,teacherCode:cls.teacherCode},t)),...collectClassesByTeacherCode(cls.teacherCode),cls]);
    return {teacherCode:cls.teacherCode,teacherName:cls.teacherName||t.teacherName||'Teacher',teacherEmail:cls.teacherEmail||t.teacherEmail||'',institute:cls.institute||t.institute||'',department:cls.department||t.department||'',subject:cls.subject||t.subject||'General',classes}
  }
  const rows=collectClassesByTeacherCode(q);
  if(rows.length){
    const first=rows[0];
    return {teacherCode:q,teacherName:first.teacherName||'Teacher',teacherEmail:first.teacherEmail||'',institute:first.institute||'',department:first.department||'',subject:first.subject||'General',classes:rows}
  }
  return null
}
function renderStudentTeacherClasses(teacher,onlyClassCode=''){
  const out=$('#asTeacherClassPicker');if(!out)return;if(!teacher){out.innerHTML='';return}
  const joined=studentJoinedCodes(),std=normalizeStudentApprovalKey(studentAccessCode()),email=String(SESSION?.email||'').toLowerCase(),filterCode=String(onlyClassCode||'').trim().toUpperCase();
  let classes=mergeClassRows(teacher.classes||[]);
  if(filterCode)classes=classes.filter(c=>String(c.code||'').toUpperCase()===filterCode);
  const head=filterCode?`<div class="notice" style="margin-bottom:10px">Class code detected — only this single class is shown.</div>`:`<div class="notice" style="margin-bottom:10px">Teacher code detected — all classes from this teacher are shown. Join only your assessments class.</div>`;
  out.innerHTML=classes.length?head+classes.map(c=>{const item=classRecordToStudentView(c,teacher),code=String(item.code).toUpperCase(),isJoined=joined.includes(code),pre=(item.allowedStudents||[]).map(normalizeStudentApprovalKey).includes(std)||(item.allowedEmails||[]).map(x=>String(x).toLowerCase()).includes(email);return `<div class="student-class-card ${isJoined?'joined':''}"><div><span>${safe(teacher.teacherName||item.teacherName||'Teacher')} · ${safe(item.subject||'General')}</span><b>${safe(item.className||'Class')}</b><div class="teacher-room-meta"><span class="badge brand">${safe(code)}</span><span class="badge">Section: ${safe(item.section||'General')}</span>${pre?'<span class="badge good">Teacher approved</span>':'<span class="badge warn">Class key needed</span>'}</div></div>${isJoined?'<div class="notice">Already joined. Assessments from this class appear in your Assessments section.</div>':(pre?`<div class="student-class-lock"><div class="notice">Teacher-approved direct access found.</div><button class="btn primary small" onclick="joinTeacherClass('${safe(item.teacherCode||teacher.teacherCode)}','${safe(code)}')">Join class</button></div>`:`<div class="student-class-lock"><input id="joinKey_${safe(code)}" class="input" placeholder="Enter class key"><button class="btn primary small" onclick="joinTeacherClass('${safe(item.teacherCode||teacher.teacherCode)}','${safe(code)}')">Join class</button></div>`)}</div>`}).join(''):'<div class="assign-class-empty"><b>No matching class found.</b><br>Use teacher invite code for all classes, or class code for one specific class.</div>'
}
function findTeacherClasses(){
  const input=$('#joinClassCode'),code=String(input?.value||'').trim().toUpperCase();
  if(!code)return toast('Enter teacher code or class code','error');
  if(code===normalizeStudentApprovalKey(studentAccessCode())||code.startsWith('STD-'))return toast('This is your student key. Share it with your teacher so they can approve you for a class.','error');
  const cls=code.startsWith('CLS-')?classDirectoryRecord(code):null;
  const teacher=teacherByInvite(code);
  if(!teacher){const out=$('#asTeacherClassPicker');if(out)out.innerHTML='<div class="assign-class-empty"><b>No teacher or class found.</b><br>Teacher code shows all classes. Class code shows one class only.</div>';return toast('Code not found','error')}
  state.joinClassFilterCode=cls&&cls.code?String(cls.code).toUpperCase():'';
  renderStudentTeacherClasses(teacher,state.joinClassFilterCode);
  toast(state.joinClassFilterCode?'One class loaded':'All teacher classes loaded','success')
}
function joinClass(){findTeacherClasses()}
function joinTeacherClass(teacherInvite,classCode){teacherInvite=String(teacherInvite||'').toUpperCase();classCode=String(classCode||'').toUpperCase();const directClass=classDirectoryRecord(classCode);if(!teacherInvite&&directClass?.teacherCode)teacherInvite=directClass.teacherCode;const teacher=teacherByInvite(teacherInvite||classCode),cls=(teacher?.classes||[]).map(c=>classRecordToStudentView(c,teacher)).find(c=>String(c.code).toUpperCase()===classCode)||directClass;if(!teacher||!cls)return toast('Class not found','error');const key=String($('#joinKey_'+classCode)?.value||'').trim().toUpperCase(),std=normalizeStudentApprovalKey(studentAccessCode()),email=String(SESSION?.email||'').toLowerCase();const pre=(cls.allowedStudents||[]).map(normalizeStudentApprovalKey).includes(std)||(cls.allowedEmails||[]).map(x=>String(x).toLowerCase()).includes(email);const keyOk=key&&key===String(cls.classKey||'').toUpperCase();if(!pre&&!keyOk)return toast('Enter correct class key, or ask teacher to approve your student key.','error');const codes=studentJoinedCodes();if(!codes.includes(classCode))codes.push(classCode);state.activeStudentClassCode=classCode;saveStudentJoinedCodes(codes);const d=profileDetails(),students=readJSON(studentsKey(classCode),[]);const meta=teacherClassMeta(classCode);const record={user_id:SESSION.user_id,username:SESSION.username,email:SESSION.email,fullName:d.fullName||SESSION.username,studentCode:std,teacherCode:teacher.teacherCode||cls.teacherCode,classCode,className:meta.className||cls.className,teacherName:meta.teacherName||teacher.teacherName||cls.teacherName,joinedAt:new Date().toISOString(),joinMethod:pre?'teacher-approved':'class-key'};const idx=students.findIndex(s=>s.user_id===SESSION.user_id||normalizeStudentApprovalKey(s.studentCode)===std);if(idx>=0)students[idx]={...students[idx],...record};else students.push(record);writeJSON(studentsKey(classCode),students);renderStudentTeacherClasses(teacher,state.joinClassFilterCode||'');paintUser();renderStudentAssignments();renderStudentDashboard();toast('Joined '+record.className,'success')}
function leaveStudentClass(code){code=String(code||'').toUpperCase();if(!code)return;if(!confirm('Remove class '+code+' from this student workspace?'))return;saveStudentJoinedCodes(studentJoinedCodes().filter(c=>c!==code));writeJSON(studentsKey(code),readJSON(studentsKey(code),[]).filter(s=>s.user_id!==SESSION.user_id&&s.studentCode!==studentAccessCode()));paintUser();renderStudentAssignments();renderStudentDashboard();toast('Class removed','success')}
function studentApprovedClasses(){
  const std=normalizeStudentApprovalKey(studentAccessCode()),email=String(SESSION?.email||'').trim().toLowerCase(),rows=[];
  const add=c=>{const item=classRecordToStudentView(c,c);if(!item.code)return;const byKey=(item.allowedStudents||[]).map(normalizeStudentApprovalKey).includes(std),byEmail=email&&(item.allowedEmails||[]).map(x=>String(x).trim().toLowerCase()).includes(email);if(byKey||byEmail)rows.push({...item,approvedByTeacher:true})};
  const cdir=readJSON(classDirectoryKey(),{});Object.values(cdir||{}).forEach(add);
  const tdir=readJSON(teacherMasterDirectoryKey(),{});Object.entries(tdir||{}).forEach(([tcode,t])=>(t.classes||[]).forEach(c=>add({...c,teacherCode:tcode,teacherName:t.teacherName,teacherEmail:t.teacherEmail,institute:t.institute,department:t.department})));
  try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i)||'';if(!k.startsWith('aqg_teacher_classes_'))continue;let arr=[];try{arr=JSON.parse(localStorage.getItem(k)||'[]')}catch(e){arr=[]}if(Array.isArray(arr))arr.forEach(add)}}catch(e){}
  return mergeClassRows(rows)
}
function studentClassRows(){
  const joined=studentJoinedCodes(),approved=studentApprovedClasses(),map=new Map();
  approved.forEach(c=>map.set(String(c.code).toUpperCase(),{...c,status:joined.includes(String(c.code).toUpperCase())?'joined':'approved'}));
  joined.forEach(code=>{const rec=classDirectoryRecord(code)||approved.find(c=>String(c.code).toUpperCase()===code)||teacherClassMeta(code);const item=classRecordToStudentView({...rec,code,classCode:code},rec);map.set(code,{...item,status:'joined'})});
  return [...map.values()].filter(c=>c.code).sort((a,b)=>Number(b.status==='joined')-Number(a.status==='joined')||String(a.className).localeCompare(String(b.className)))
}
function openStudentClassAssignments(code){state.activeStudentClassCode=String(code||'').toUpperCase();renderStudentAssignments();showPanel('sAssignmentsPanel')}
function joinApprovedStudentClass(code){
  code=String(code||'').toUpperCase();const cls=classDirectoryRecord(code)||studentApprovedClasses().find(c=>String(c.code).toUpperCase()===code);
  if(!cls)return toast('Approved class not found. Ask teacher to refresh/save the class again.','error');
  joinTeacherClass(cls.teacherCode||'',code)
}
function getStudentAssignments(classCode=''){
  const filter=String(classCode||'').trim().toUpperCase(),codes=studentJoinedCodes(),map=new Map();
  codes.forEach(code=>{if(filter&&code!==filter)return;readJSON(classAssignmentsKey(code),[]).forEach(a=>{const key=(a.id||a.title||'assignment')+'_'+code;map.set(key,{...a,classCode:a.classCode||code,joinedClassCode:code})})});
  return [...map.values()].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))
}
function renderStudentAssignments(){
  const out=$('#studentAssignmentsOut');if(!out)return;
  const d=profileDetails(),codes=studentJoinedCodes(),classes=studentClassRows(),allRows=getStudentAssignments(),total=allRows.reduce((s,a)=>s+(parseInt(a.count,10)||0),0),stdCode=studentAccessCode(),approvedOnly=classes.filter(c=>c.status==='approved').length;
  const set=(id,v)=>{const el=$('#'+id);if(el)el.textContent=v};
  set('asClassCode',codes.length?codes.length+' joined':'0 joined');set('asTotal',allRows.length);set('asQuestions',total);set('asStudentCode',stdCode);set('asStudentAccessCode',stdCode);set('asJoinedCount',codes.length+' joined'+(approvedOnly?' · '+approvedOnly+' approved':''));set('saClassCount',codes.length?codes.length+' joined':'0');set('saAssignmentTotal',allRows.length);set('saQuestionTotal',total);
  const inp=$('#joinClassCode');if(inp)inp.placeholder='Teacher code or class code: TCH-AB12 / CLS-1234';
  const chip=$('#asCurrentClass');if(chip)chip.innerHTML=codes.length?`Connected to <b>${safe(codes.length+' joined class'+(codes.length>1?'es':''))}</b>${approvedOnly?' · '+approvedOnly+' approved pending':''}`:(approvedOnly?`<b>${approvedOnly} approved class${approvedOnly>1?'es':''}</b> waiting to join`:'No teacher class connected');
  let active=String(state.activeStudentClassCode||'').toUpperCase();
  if(active&&!classes.some(c=>String(c.code).toUpperCase()===active))active='';
  if(!active)active=codes[0]||(classes[0]?.code||'');
  state.activeStudentClassCode=active;
  const list=$('#asClassList');
  if(list)list.innerHTML=classes.length?classes.map(c=>{const code=String(c.code).toUpperCase(),joined=c.status==='joined',activeClass=active===code,count=readJSON(classAssignmentsKey(code),[]).length;return `<div class="student-class-open-card ${joined?'joined':'approved'} ${activeClass?'active':''}"><div class="student-class-open-top"><div><span>${joined?'Joined class':'Teacher approved'}</span><div class="student-class-open-title">${safe(c.className||'Academic Class')}</div><div class="student-class-open-meta"><span class="badge brand">${safe(code)}</span><span class="badge">Teacher: ${safe(c.teacherName||'Teacher')}</span><span class="badge">${count} assignment${count===1?'':'s'}</span>${joined?'<span class="badge good">Joined</span>':'<span class="badge warn">Not joined yet</span>'}</div></div></div><div class="student-class-open-actions">${joined?`<button class="btn primary small" onclick="openStudentClassAssignments('${safe(code)}')">Open assignments</button><button class="btn danger small" onclick="leaveStudentClass('${safe(code)}')">Remove</button>`:`<button class="btn primary small" onclick="joinApprovedStudentClass('${safe(code)}')">Join approved class</button>`}</div></div>`}).join(''):`<div class="assign-class-empty"><b>No class found yet.</b><br>Enter teacher code to view all classes, class code to view one class, or ask teacher to approve your student key.</div>`;
  const title=$('#asSelectedClassTitle'),hint=$('#asSelectedClassHint');
  const activeMeta=classes.find(c=>String(c.code).toUpperCase()===active)||null,activeJoined=active&&codes.includes(active);
  const rows=activeJoined?getStudentAssignments(active):[];
  set('asListBadge',activeJoined?rows.length+' active':(activeMeta?'Join class':'0 active'));set('saActiveClass',activeMeta?(activeMeta.className||activeMeta.code||'Class'):'None');
  if(title)title.textContent=activeMeta?`${activeMeta.className||'Class'} assessments`:'Class assessments';
  if(hint)hint.textContent=activeMeta?(activeJoined?'Only assignments from this selected class are shown here.':'This class is approved for you. Join it first, then its assignments will show here.'):'Open a class from the classes board to see assignments here.';
  const info=$('#asStudentBox');if(info){const p=[['Student',d.fullName||SESSION.username||'Student'],['Student key',stdCode],['Roll / ID',d.academicId||d.studentId||d.academicId||'Not added'],['Institute',d.institute||d.university||'Not added'],['Department',d.department||'Not added']];info.innerHTML=p.map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}
  const flow=$('#asFlowBox');if(flow)flow.innerHTML=[['Teacher code','Shows all classes from one teacher.'],['Class code','Shows only that one class.'],['Approved key','Teacher-approved classes appear here and join without class key.']].map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('');
  if(!activeMeta){out.innerHTML=`<div class="class-assignment-empty"><div><h3>No class selected</h3><p>Use a teacher code, class code, or ask teacher to approve your student key. Approved classes will appear in the classes board.</p></div></div>`;return}
  if(!activeJoined){out.innerHTML=`<div class="class-assignment-empty"><div><h3>${safe(activeMeta.className||'Approved class')}</h3><p>Your teacher approved your student key for this class. Join it without entering the class key, then assessments will appear here.</p><button class="btn primary small" style="margin-top:12px" onclick="joinApprovedStudentClass('${safe(active)}')">Join approved class</button></div></div>`;return}
  if(!rows.length){out.innerHTML=`<div class="class-assignment-empty"><div><h3>No assignments in this class yet</h3><p>${safe(activeMeta.teacherName||'Teacher')} has not assigned a quiz to ${safe(activeMeta.className||'this class')} yet.</p><button class="btn ghost small" style="margin-top:12px" onclick="renderStudentAssignments()">Refresh class</button></div></div>`;return}
  out.innerHTML=rows.map((a,i)=>{const due=a.due?new Date(a.due).toLocaleDateString():'No due date',ins=a.instructions||'No extra instructions from teacher.',code=a.joinedClassCode||a.classCode||'Class',meta=teacherClassMeta(code),className=a.className||meta.className,teacher=a.teacherName||meta.teacherName;return `<div class="assignment-pro-card"><div><span>Assessment ${rows.length-i} · ${safe(className)}</span><h3>${safe(a.title)}</h3><p class="muted">${safe(a.subject||meta.subject||'General')} · ${a.count} MCQs · Teacher: ${safe(teacher)}</p><div class="assignment-pro-meta"><span class="badge brand">Code: ${safe(code)}</span><span class="badge">Class: ${safe(className)}</span><span class="badge">Teacher: ${safe(teacher)}</span><span class="badge">Due: ${safe(due)}</span></div><div class="assignment-pro-note"><b>Teacher instructions</b>${safe(ins)}</div></div><div class="assignment-pro-actions"><button class="btn primary small" onclick="startAssignment(${a.id})">Open quiz</button><button class="btn ghost small" onclick="showPanel('historyPanel')">Results</button></div></div>`}).join('')
}
function startAssignment(id){const a=getStudentAssignments().find(x=>String(x.id)===String(id));if(!a)return;const code=a.joinedClassCode||a.classCode||'';const meta=teacherClassMeta(code);state.activeAssignmentMeta={origin:'teacher',assignmentId:a.id,assignmentTitle:a.title,title:a.title,classCode:code,className:a.className||meta.className,teacherName:a.teacherName||meta.teacherName,subject:a.subject||meta.subject||'General',due:a.due||'',instructions:a.instructions||'',count:a.count||getCount()};focusQuizMode(false);$('#quizTitle').value=a.title;$('#textData').value=a.content;$('#customCount').value=a.count;setSource('text');updateTextStats();showPanel('generatePanel');toast('Assignment loaded with teacher/class identity for history. Generate quiz to begin.','success')}
function renderTeacherStudents(){
  const out=$('#teacherStudentsOut');if(!out)return;const classes=ensureTeacherClasses(),tcode=teacherCode(),totalStudents=classes.reduce((n,c)=>n+readJSON(studentsKey(c.code),[]).length,0),totalAssignments=readJSON(assignmentsKey(),[]).length;
  const summary=`<div class="teacher-class-summary"><div><span>Teacher invite code</span><b class="mono">${safe(tcode)}</b></div><div><span>Total classes</span><b>${classes.length}</b></div><div><span>Enrolled students</span><b>${totalStudents}</b></div><div><span>Assessments</span><b>${totalAssignments}</b></div></div>`;
  const form=`<div class="teacher-class-form"><div class="form-group"><label class="label">Class name</label><input id="tcName" class="input" placeholder="BS AI Semester 2"></div><div class="form-group"><label class="label">Subject</label><input id="tcSubject" class="input" placeholder="Machine Learning"></div><div class="form-group"><label class="label">Section</label><input id="tcSection" class="input" placeholder="A / Morning"></div><div class="form-group"><label class="label">Class key</label><input id="tcKey" class="input" placeholder="Auto"></div><button class="btn primary" onclick="createTeacherClass()">Create class</button></div><div class="teacher-create-note">Students can use your teacher code to discover all classes, or a class code to open one class. You can also approve a student directly with their student code or email.</div>`;
  const cards=classes.map(c=>{const rows=readJSON(studentsKey(c.code),[]),assignments=readJSON(classAssignmentsKey(c.code),[]),allowed=[...(c.allowedStudents||[]),...(c.allowedEmails||[])];return `<div class="teacher-room-card ${c.code===activeTeacherClassCode()?'active':''}"><div class="teacher-room-top"><div><div class="teacher-room-title">${safe(c.className)}</div><div class="teacher-room-meta"><span class="badge brand">${safe(c.code)}</span><span class="badge">Key: ${safe(c.classKey)}</span><span class="badge">${safe(c.subject||'General')}</span></div></div><button class="btn ghost small" onclick="setActiveTeacherClass('${safe(c.code)}')">Make active</button></div><div class="teacher-room-stats"><div><span>Students</span><b>${rows.length}</b></div><div><span>Assessments</span><b>${assignments.length}</b></div><div><span>Approved keys</span><b>${allowed.length}</b></div></div><div class="teacher-student-add"><input id="allow_${safe(c.code)}" class="input" placeholder="Add student key/code or email: STD-ALI-1234"><button class="btn small primary" onclick="addAllowedStudents('${safe(c.code)}')">Approve</button></div><div class="teacher-student-list">${allowed.length?allowed.map(v=>`<div class="teacher-student-chip"><div><span>Approved access key</span><b>${safe(v)}</b><small>Teacher-approved direct access.</small></div><button class="btn danger small" onclick="removeAllowedStudent('${safe(c.code)}','${safe(v)}')">×</button></div>`).join(''):'<div class="hint">No approved keys yet. Add a student key/code or email to approve direct access.</div>'}${rows.length?rows.map(s=>`<div class="teacher-student-chip"><div><span>Joined student</span><b>${safe(s.fullName||s.username)}</b><small>${safe(s.studentCode||'No code')} · ${safe(s.email||'No email')}</small></div><button class="btn danger small" onclick="removeClassStudent('${safe(c.code)}',${Number(s.user_id)||0})">Remove</button></div>`).join(''):''}</div><div class="teacher-room-actions"><button class="btn ghost small" onclick="navigator.clipboard?.writeText('${safe(tcode)}');toast('Teacher code copied','success')">Copy teacher code</button><button class="btn ghost small" onclick="navigator.clipboard?.writeText('${safe(c.code)}');toast('Class code copied','success')">Copy class code</button><button class="btn ghost small" onclick="navigator.clipboard?.writeText('${safe(c.classKey)}');toast('Class key copied','success')">Copy class key</button><button class="btn danger small" onclick="deleteTeacherClass('${safe(c.code)}')">Delete class</button></div></div>`}).join('');
  out.innerHTML=`<div class="teacher-class-admin classes-shell">${summary}<section class="classes-surface teacher-create-block"><div class="teacher-block-head"><div><h2>Create a class</h2><p>Add only the basic academic details. A class code and secure access flow are handled automatically.</p></div><span class="badge brand">New class</span></div>${form}</section><section class="classes-surface teacher-rooms-block"><div class="teacher-rooms-heading"><div><h2>Your classes</h2><p>Open a class, review its students, or copy the access details you need.</p></div><span class="badge">${classes.length} class${classes.length===1?'':'es'}</span></div><div class="teacher-class-board">${cards||'<div class="assignment-empty-slim"><h3>No classes yet</h3><p>Create your first class above.</p></div>'}</div></section></div>`;
}

function analyticsClassStudentRows(code){
  code=String(code||'').toUpperCase();
  const joined=readJSON(studentsKey(code),[]),subs=teacherSubmittedAssignmentsFor(code),map=new Map();
  const keyOf=x=>String(x.studentCode||x.email||x.studentEmail||x.user_id||x.studentUserId||x.username||x.studentName||'').toLowerCase();
  joined.forEach(s=>{const k=keyOf(s);if(k)map.set(k,{...s,submissions:[]})});
  subs.forEach(r=>{const k=keyOf(r);if(!k)return;if(!map.has(k))map.set(k,{fullName:r.studentName||'Student',username:r.studentName||'Student',email:r.studentEmail||'',studentCode:r.studentCode||'',submissions:[]});map.get(k).submissions.push(r)});
  return [...map.values()].map(s=>{
    const rows=s.submissions||[],assignmentIds=new Set(rows.map(r=>String(r.assignmentId||r.assignmentTitle||r.title||'')).filter(Boolean));
    const total=rows.reduce((n,r)=>n+(Number(r.total)||0),0),correct=rows.reduce((n,r)=>n+(Number(r.score)||0),0),wrong=Math.max(0,total-correct),avg=total?Math.round(correct/total*100):0;
    return {...s,submittedAssignments:assignmentIds.size,attempts:rows.length,totalQuestions:total,correct,wrong,avg,lastSubmitted:rows[0]?.submittedAt||rows[0]?.at||''}
  }).sort((a,b)=>Number(b.avg||0)-Number(a.avg||0)||String(a.fullName||a.username||'').localeCompare(String(b.fullName||b.username||'')))
}
function openTeacherAnalyticsClass(code){state.activeAnalyticsClassCode=String(code||'').toUpperCase();renderTeacherAnalytics()}
function analyticsAssignToClass(code){teacherAssignToClass(String(code||'').toUpperCase())}
function analyticsOpenAssignmentWorkspace(code){state.activeTeacherAssignmentsClassCode=String(code||'').toUpperCase();selectTeacherAssignmentClass(state.activeTeacherAssignmentsClassCode);showPanel('teacherAssignmentsPanel')}
function renderTeacherAnalytics(){
  const classes=ensureTeacherClasses(),allAssignments=readJSON(assignmentsKey(),[]),studentsTotal=classes.reduce((n,c)=>n+readJSON(studentsKey(c.code),[]).length,0);
  let active=String(state.activeAnalyticsClassCode||activeTeacherClassCode()||classes[0]?.code||'').toUpperCase();
  if(active&&!classes.some(c=>String(c.code).toUpperCase()===active))active=classes[0]?.code||'';
  state.activeAnalyticsClassCode=active;
  const activeMeta=classes.find(c=>String(c.code).toUpperCase()===active)||null,activeRows=active?analyticsClassStudentRows(active):[],activeAssignments=active?readJSON(classAssignmentsKey(active),[]):[],activeSubs=active?teacherSubmittedAssignmentsFor(active):[];
  const avg=avgSubmissionPct(activeSubs),correct=activeRows.reduce((n,s)=>n+(Number(s.correct)||0),0),wrong=activeRows.reduce((n,s)=>n+(Number(s.wrong)||0),0);
  const classCards=classes.length?classes.map(c=>{
    const code=String(c.code).toUpperCase(),students=readJSON(studentsKey(code),[]),assignments=readJSON(classAssignmentsKey(code),[]),subs=teacherSubmittedAssignmentsFor(code),pct=avgSubmissionPct(subs),opened=code===active;
    return `<div class="analytics-class-card ${opened?'active':''}"><div class="analytics-class-top"><div><div class="analytics-class-title">${safe(c.className||'Academic Class')}</div><div class="teacher-room-meta" style="margin-top:10px"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span><span class="badge">Key: ${safe(c.classKey||'-')}</span></div></div><div class="analytics-action-row"><button class="btn primary small" onclick="openTeacherAnalyticsClass('${safe(code)}')">Open</button><button class="btn good small" onclick="analyticsAssignToClass('${safe(code)}')">Create</button><button class="btn ghost small" onclick="analyticsOpenAssignmentWorkspace('${safe(code)}')">Assignments</button></div></div><div class="teacher-room-stats"><div><span>Students</span><b>${students.length}</b></div><div><span>Assessments</span><b>${assignments.length}</b></div><div><span>Average</span><b>${pct}%</b></div></div></div>`
  }).join(''):`<div class="assignment-empty-slim"><h3>No class yet</h3><p>Create classes first from Classes & enrollment.</p></div>`;
  const studentRows=activeRows.length?activeRows.map(s=>{
    const name=s.fullName||s.username||s.studentName||'Student',code=s.studentCode||'No code',mail=s.email||s.studentEmail||'No email',pending=Math.max(0,activeAssignments.length-(Number(s.submittedAssignments)||0));
    return `<div class="analytics-student-row"><div class="analytics-student-main"><b>${safe(name)}</b><small>${safe(code)} · ${safe(mail)}</small></div><div class="analytics-mini-box"><span>Submitted</span><b>${safe(s.submittedAssignments||0)}/${activeAssignments.length}</b></div><div class="analytics-mini-box"><span>Correct</span><b>${safe(s.correct||0)}</b></div><div class="analytics-mini-box"><span>Wrong</span><b>${safe(s.wrong||0)}</b></div><div class="analytics-mini-box"><span>Average</span><b>${safe(s.avg||0)}%</b></div><div class="analytics-mini-box"><span>Pending</span><b>${pending}</b></div></div>`
  }).join(''):`<div class="assignment-empty-slim"><h3>No student progress yet</h3><p>When students join and submit assignments, their correct/wrong numbers will appear here.</p></div>`;
  const assignmentRows=activeAssignments.length?activeAssignments.map(a=>{
    const subs=teacherSubmittedAssignmentsFor(active,a.id),unique=uniqueSubmissionStudents(subs),aAvg=avgSubmissionPct(subs),aCorrect=subs.reduce((n,r)=>n+(Number(r.score)||0),0),aTotal=subs.reduce((n,r)=>n+(Number(r.total)||0),0),aWrong=Math.max(0,aTotal-aCorrect);
    return `<div class="analytics-assignment-row"><div><span class="badge brand">${safe(a.subject||activeMeta?.subject||'General')}</span><h3>${safe(a.title||'Assignment')}</h3><p>${unique}/${activeRows.length} students submitted · ${aCorrect} correct · ${aWrong} wrong · Due ${safe(a.due||'No due date')}</p></div><div class="analytics-score-pill">${aAvg}%</div></div>`
  }).join(''):`<div class="assignment-empty-slim"><h3>No assignment yet</h3><p>Use Assign button to publish assignment for this class.</p><button class="btn primary small" style="margin-top:10px" onclick="analyticsAssignToClass('${safe(active)}')">Create assessment</button></div>`;
  $('#teacherAnalyticsOut').innerHTML=`<div class="analytics-pro-shell"><div class="grid-3"><div class="kpi"><b>${classes.length}</b><span>Total classes</span></div><div class="kpi"><b>${allAssignments.length}</b><span>Assessments published</span></div><div class="kpi"><b>${studentsTotal}</b><span>Students joined locally</span></div></div><div class="card card-pad"><div class="card-title">Class analytics</div><div class="teacher-class-board" style="margin-top:14px">${classCards}</div></div>${activeMeta?`<div class="analytics-detail-card"><div class="analytics-detail-head"><div><span class="badge brand">Open class · ${safe(active)}</span><h2>${safe(activeMeta.className||'Academic Class')}</h2><p>${safe(activeMeta.subject||'General')} · ${activeRows.length} student${activeRows.length===1?'':'s'} · ${activeAssignments.length} assignment${activeAssignments.length===1?'':'s'} · ${avg}% class average</p></div><div class="analytics-action-row"><button class="btn primary small" onclick="analyticsAssignToClass('${safe(active)}')">Create assessment</button><button class="btn ghost small" onclick="analyticsOpenAssignmentWorkspace('${safe(active)}')">Open assignments</button></div></div><div class="assignment-progress-summary"><div><span>Correct</span><b>${correct}</b></div><div><span>Wrong</span><b>${wrong}</b></div><div><span>Submissions</span><b>${activeSubs.length}</b></div><div><span>Average</span><b>${avg}%</b></div></div><div class="card-title" style="margin-top:18px">Student progress</div><div class="analytics-student-grid">${studentRows}</div><div class="card-title" style="margin-top:18px">Assignment progress</div><div class="analytics-assignment-grid">${assignmentRows}</div></div>`:''}</div>`
}

function revisionStoreKey(){return 'aqg_revision_sets_'+sessionKey()}
function revisionSets(){return readJSON(revisionStoreKey(),[])}
function writeRevisionSets(arr){writeJSON(revisionStoreKey(),arr.slice(0,40))}
function cloneQuizForRevision(quiz){return (quiz||[]).map((q,i)=>normalizeQuestion({...q,options:Array.isArray(q.options)?q.options.slice():[]},i))}
function activeRevisionDeck(){return state.revisionDeck&&Array.isArray(state.revisionDeck.quiz)&&state.revisionDeck.quiz.length?state.revisionDeck.quiz:state.quiz}
function activeRevisionTitle(){return state.revisionDeck?.title||($('#quizTitle')?.value||'').trim()||state.lastResult?.title||'Current quiz'}
function flashcards(){return activeRevisionDeck().map((q,i)=>({front:q.question,back:q.correct,options:q.options||[],difficulty:q.difficulty||'medium',index:i}))}
function weakQuizStoreKey(){return 'aqg_auto_weak_revision_quizzes_'+sessionKey()}
function weakQuizSets(){return readJSON(weakQuizStoreKey(),[])}
function writeWeakQuizSets(arr){writeJSON(weakQuizStoreKey(),arr.slice(0,30))}
function currentWeakCards(){if(!state.quiz.length||!state.submitted)return[];return state.quiz.map((q,i)=>{const picked=state.answered[i];const selected=picked!=null?q.options[picked]:'Skipped';const ok=picked!=null&&q.options[picked]===q.correct;return ok?null:{q:normalizeQuestion(q,i),i,selected,skipped:picked==null}}).filter(Boolean)}
function isPersonalQuizForWeakMove(){let meta=null;try{meta=typeof currentAssignmentHistoryMeta==='function'?currentAssignmentHistoryMeta():null}catch(e){meta=null}return !state.activeAssignmentMeta&&!meta}
function saveAutoWeakQuiz(score,total,pct,answered,wrong,skipped,title,time,at){
  if(Number(pct)>=75||!state.quiz.length||!isPersonalQuizForWeakMove())return;
  const weak=currentWeakCards();
  const item={id:'weak_'+Date.now(),title:title||'Personal weak quiz',createdAt:new Date().toISOString(),score,total,pct,answered,wrong,skipped,time,at,quiz:cloneQuizForRevision(state.quiz),weak:weak.map(w=>({i:w.i,selected:w.selected,skipped:w.skipped,q:normalizeQuestion(w.q,w.i)}))};
  const arr=weakQuizSets().filter(x=>!(String(x.title).toLowerCase()===String(item.title).toLowerCase()&&Number(x.total)===Number(item.total)));
  arr.unshift(item);writeWeakQuizSets(arr);
  const questions=state.quiz.map((q,i)=>({question:q.question,options:q.options,correctAnswer:q.correct,selectedAnswer:state.answered[i]!=null?q.options[state.answered[i]]:null,correct:state.answered[i]!=null&&q.options[state.answered[i]]===q.correct,difficulty:q.difficulty||'medium'}));
  request('/api/v1/revision/items',{method:'POST',body:JSON.stringify({source_type:'personal_quiz',source_id:state.sessionId||null,title:item.title,score_pct:Number(pct),questions})}).catch(()=>{});
  toast('Personal quiz under 75% moved to Auto Weak Revision Desk','success')
}
function revisionNotesKey(){return 'aqg_revision_notes_'+sessionKey()}
function revisionNotesListKey(){return 'aqg_revision_notes_list_'+sessionKey()}
function revisionNotesList(){return readJSON(revisionNotesListKey(),[])}
function writeRevisionNotesList(arr){writeJSON(revisionNotesListKey(),arr.slice(0,30))}
function revisionDom(id){return document.getElementById(id)}
function setRevisionText(id,value){const el=revisionDom(id);if(el)el.textContent=value}
function noteTitle(text){return String(text||'Revision note').trim().split(/\s+/).slice(0,7).join(' ')||'Revision note'}
function selectedRevisionSet(){return state.revisionDeck&&Array.isArray(state.revisionDeck.quiz)?state.revisionDeck:null}
async function renderRevision(){
  try{const remote=await request('/api/v1/revision/dashboard');if(remote){if(Array.isArray(remote.notes)){const mapped=remote.notes.map(n=>({...n,id:'srv_'+n.id}));writeRevisionNotesList(mapped)}if(Array.isArray(remote.items)){const mapped=remote.items.map(x=>({id:'srv_'+x.id,title:x.title,createdAt:x.createdAt,score:x.scorePct,total:x.questionCount,pct:x.scorePct,quiz:(x.weakQuestions||[]).map((q,i)=>normalizeQuestion({question:q.question||q.question_body||'Revision question',options:q.options||[],correct:q.correctAnswer||q.correct||'',difficulty:q.difficulty||'medium'},i)),weak:x.weakQuestions||[]}));writeWeakQuizSets(mapped)}state.revisionRemote=remote}}catch(e){}
  const notes=revisionDom('revisionNotes');
  if(notes&&!notes.dataset.loaded){notes.value=localStorage.getItem(revisionNotesKey())||'';notes.dataset.loaded='1'}
  const deck=activeRevisionDeck(),sets=revisionSets(),weakSets=weakQuizSets();
  setRevisionText('revCardsMetric',deck.length||0);
  setRevisionText('revWeakMetric',weakSets.length||0);
  setRevisionText('revSetsMetric',sets.length||0);
  setRevisionText('revDeckMetric',state.revisionDeck?.title?'Selected':(deck.length?'Current':'None'));
  setRevisionText('revDeckHint',state.revisionDeck?.title||(`${deck.length||0} questions ready`));
  renderRevisionLibrary();renderRevisionPractice();renderWeakRevision();renderSavedRevisionNotes();
  const plan=revisionDom('revisionPlan');if(plan&&!plan.innerHTML)buildRevisionPlan(false)
}
function renderRevisionPractice(){
  const box=revisionDom('revisionPracticeOut');if(!box)return;
  const deck=activeRevisionDeck(),title=activeRevisionTitle();
  if(!deck.length){box.innerHTML='<div class="rev-empty"><div><b>No practice quiz selected</b>Generate a quiz or open a saved set to preview questions here.</div></div>';return}
  const preview=deck.slice(0,5).map((q,i)=>`<div class="rev-preview-q"><b>${i+1}. ${safe(q.question)}</b><span>Answer: ${safe(q.correct)}</span></div>`).join('');
  box.innerHTML=`<div class="rev-practice-head"><div><span class="rev-label">Practice Quiz</span><div class="rev-card-title">${safe(title)}</div><div class="rev-card-sub">${deck.length} questions ready for revision or retake.</div></div><span class="badge brand">${deck.length} MCQs</span></div><div class="rev-preview-list">${preview}${deck.length>5?`<div class="rev-empty" style="min-height:72px"><div><b>+${deck.length-5} more questions</b>Start as test or download PDF for the full set.</div></div>`:''}</div><div class="rev-action-row"><button class="btn primary" onclick="startActiveRevisionAsTest()">Start as test</button><button class="btn ghost" onclick="downloadActiveRevisionPDF()">Download PDF</button></div>`
}
function renderRevisionLibrary(){
  const box=revisionDom('revisionLibrary');if(!box)return;const sets=revisionSets();
  if(!sets.length){box.innerHTML='<div class="rev-empty"><div><b>No saved sets yet</b>Generate a quiz and press Save current quiz to keep it here.</div></div>';return}
  box.innerHTML=sets.map(x=>`<div class="rev-set"><div class="rev-set-top"><div><h3>${safe(x.title)}</h3><div class="rev-small-text">${new Date(x.createdAt).toLocaleDateString()} · ${x.total||x.quiz?.length||0} questions${x.score!=null?' · '+x.score+'% result':''}</div></div><span class="badge brand">Saved</span></div><div class="rev-action-row"><button class="btn small primary" onclick="openRevisionSet('${x.id}')">Study</button><button class="btn small ghost" onclick="startRevisionSet('${x.id}')">Start test</button><button class="btn small ghost" onclick="downloadRevisionSetPDF('${x.id}')">PDF</button><button class="btn small danger" onclick="deleteRevisionSet('${x.id}')">Delete</button></div></div>`).join('')
}
async function saveRevisionNotes(){
  const notes=revisionDom('revisionNotes');const text=(notes?.value||'').trim();
  if(!text)return toast('Write a note first','error');
  const item={id:'note_'+Date.now(),title:noteTitle(text),text,createdAt:new Date().toISOString()};
  const arr=revisionNotesList();arr.unshift(item);writeRevisionNotesList(arr);
  state.revisionNoteId=item.id;if(notes)notes.value='';localStorage.removeItem(revisionNotesKey());
  try{const saved=await request('/api/v1/revision/notes',{method:'POST',body:JSON.stringify({title:item.title,body:item.text})});item.id='srv_'+saved.id}catch(e){}
  renderSavedRevisionNotes();toast('Revision note saved','success')
}
function selectedRevisionNote(){const notes=revisionNotesList();return notes.find(x=>String(x.id)===String(state.revisionNoteId))||notes[0]||null}
function renderSavedRevisionNotes(){
  const box=revisionDom('revisionNotesList');if(!box)return;const notes=revisionNotesList();
  setRevisionText('revNotesCount',`${notes.length} note${notes.length===1?'':'s'}`);
  if(!notes.length){state.revisionNoteId=null;box.innerHTML='<div class="rev-empty"><div><b>No saved notes yet</b>Write a note above and press Save note. Your saved notes will appear here.</div></div>';renderRevisionNoteReader(null);return}
  const current=selectedRevisionNote();state.revisionNoteId=current.id;
  box.innerHTML=notes.map(n=>`<div class="rev-note-item ${String(n.id)===String(state.revisionNoteId)?'active':''}" onclick="selectRevisionNote('${n.id}')"><div><b>${safe(n.title||noteTitle(n.text))}</b><div class="rev-small-text">${new Date(n.createdAt).toLocaleString()} · ${String(n.text||'').split(/\s+/).filter(Boolean).length} words</div></div><div class="rev-action-row"><button class="btn small ghost" onclick="event.stopPropagation();selectRevisionNote('${n.id}')">Open</button><button class="btn small danger" onclick="event.stopPropagation();deleteRevisionNote('${n.id}')">Delete</button></div></div>`).join('');
  renderRevisionNoteReader(current)
}
function renderRevisionNoteReader(n){
  setRevisionText('revisionNoteReaderMeta',n?new Date(n.createdAt).toLocaleString():'No note selected');
  setRevisionText('revisionNoteReaderTitle',n?(n.title||noteTitle(n.text)):'Open a saved note');
  setRevisionText('revisionNoteReaderHint',n?'Use the note actions below to create MCQs, download, or copy.':'Select any saved note from the left side to view it here.');
  const body=revisionDom('revisionNoteReaderBody');if(body)body.textContent=n?n.text:'No note selected yet.'
}
function selectRevisionNote(id){const n=revisionNotesList().find(x=>String(x.id)===String(id));if(!n)return toast('Note not found','error');state.revisionNoteId=n.id;renderSavedRevisionNotes()}
function openRevisionNote(id){selectRevisionNote(id)}
async function deleteRevisionNote(id){if(!confirm('Delete this note?'))return;const raw=String(id);if(raw.startsWith('srv_')){try{await request('/api/v1/revision/notes/'+raw.slice(4),{method:'DELETE'})}catch(e){return toast(e.message,'error')}}writeRevisionNotesList(revisionNotesList().filter(x=>String(x.id)!==raw));if(String(state.revisionNoteId)===raw)state.revisionNoteId=null;renderSavedRevisionNotes();toast('Note deleted','success')}
function downloadNoteFile(n){const blob=new Blob([n.text],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=((n.title||'revision-note').replace(/[^a-z0-9_-]+/gi,'_').slice(0,55)||'revision-note')+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),400)}
function downloadOpenRevisionNote(){const n=selectedRevisionNote();if(!n)return toast('Open a note first','error');downloadNoteFile(n)}
async function copyOpenRevisionNote(){const n=selectedRevisionNote();if(!n)return toast('Open a note first','error');try{await navigator.clipboard.writeText(n.text);toast('Note copied','success')}catch{toast('Copy not available in this browser','error')}}
function makeMcqsFromOpenRevisionNote(){const n=selectedRevisionNote();if(!n)return toast('Open a note first','error');if(String(n.text||'').trim().length<50)return toast('Note is too short for MCQs','error');setSource('text');if($('#textData'))$('#textData').value=n.text;if($('#quizTitle'))$('#quizTitle').value='Note MCQs · '+(n.title||noteTitle(n.text));updateTextStats();showPanel('generatePanel');setTimeout(()=>generateQuiz(),80)}
function saveCurrentRevisionSet(){
  if(!state.quiz.length)return toast('Generate or open a quiz first','error');
  const title=($('#quizTitle')?.value||'').trim()||state.lastResult?.title||'Revision Set';
  const item={id:'rev_'+Date.now(),title,createdAt:new Date().toISOString(),quiz:cloneQuizForRevision(state.quiz),score:state.lastResult?.pct??null,total:state.quiz.length};
  const arr=revisionSets().filter(x=>String(x.title).toLowerCase()!==String(title).toLowerCase());arr.unshift(item);writeRevisionSets(arr);
  state.revisionDeck={id:item.id,title:item.title,quiz:cloneQuizForRevision(item.quiz)};renderRevision();toast('Quiz saved to Revision Studio','success')
}
function findRevisionSet(id){return revisionSets().find(x=>String(x.id)===String(id))}
function openRevisionSet(id){const set=findRevisionSet(id);if(!set)return toast('Revision set not found','error');state.revisionDeck={id:set.id,title:set.title,quiz:cloneQuizForRevision(set.quiz)};renderRevision();revisionDom('revisionPracticeOut')?.scrollIntoView({behavior:'smooth',block:'center'});toast('Revision set opened','success')}
function startRevisionSet(id){const set=findRevisionSet(id);if(!set)return toast('Revision set not found','error');startRevisionQuiz(cloneQuizForRevision(set.quiz),set.title);state.revisionDeck={id:set.id,title:set.title,quiz:cloneQuizForRevision(set.quiz)}}
function deleteRevisionSet(id){if(!confirm('Delete this revision set?'))return;writeRevisionSets(revisionSets().filter(x=>String(x.id)!==String(id)));if(state.revisionDeck&&String(state.revisionDeck.id)===String(id))state.revisionDeck=null;renderRevision();toast('Revision set deleted','success')}
function downloadRevisionSetPDF(id){const set=findRevisionSet(id);if(!set)return toast('Revision set not found','error');downloadRevisionQuizPDF(set.title,set.quiz,'Revision Studio Pack')}
function renderWeakRevision(){
  const box=revisionDom('weakRevisionOut');if(!box)return;const sets=weakQuizSets();
  if(!sets.length){box.innerHTML='<div class="rev-empty"><div><b>No weak quiz yet</b>Submit a personal quiz below 75%. It will appear here automatically.</div></div>';return}
  box.innerHTML=sets.map(x=>`<div class="rev-weak-quiz"><div class="rev-weak-top"><div><h3>${safe(x.title)}</h3><p class="rev-small-text">Moved automatically because this personal quiz scored below 75%.</p></div><span class="rev-weak-score">${x.pct}%</span></div><div class="rev-meta"><span class="badge">${x.score}/${x.total} marks</span><span class="badge warn">${x.wrong||0} wrong</span><span class="badge">${x.skipped||0} skipped</span><span class="badge brand">${new Date(x.createdAt).toLocaleDateString()}</span></div><div class="rev-weak-actions"><button class="btn small primary" onclick="studyWeakQuiz('${x.id}')">Study</button><button class="btn small ghost" onclick="startWeakQuiz('${x.id}')">Start same quiz</button><button class="btn small ghost" onclick="downloadWeakQuizPDF('${x.id}')">PDF</button><button class="btn small danger" onclick="deleteWeakQuiz('${x.id}')">Delete</button></div></div>`).join('')
}
function findWeakQuiz(id){return weakQuizSets().find(x=>String(x.id)===String(id))}
function studyWeakQuiz(id){const set=findWeakQuiz(id);if(!set)return toast('Weak quiz not found','error');state.revisionDeck={id:set.id,title:set.title,quiz:cloneQuizForRevision(set.quiz)};renderRevision();revisionDom('revisionPracticeOut')?.scrollIntoView({behavior:'smooth',block:'center'});toast('Weak quiz opened for study','success')}
function startWeakQuiz(id){const set=findWeakQuiz(id);if(!set)return toast('Weak quiz not found','error');startRevisionQuiz(cloneQuizForRevision(set.quiz),set.title);state.revisionDeck={id:set.id,title:set.title,quiz:cloneQuizForRevision(set.quiz)}}
function deleteWeakQuiz(id){if(!confirm('Remove this weak quiz?'))return;writeWeakQuizSets(weakQuizSets().filter(x=>String(x.id)!==String(id)));renderRevision();toast('Weak quiz removed','success')}
function downloadWeakQuizPDF(id){const set=findWeakQuiz(id);if(!set)return toast('Weak quiz not found','error');downloadRevisionQuizPDF(set.title,set.quiz,'Auto Weak Revision Quiz')}
function startWeakRevision(){const sets=weakQuizSets();if(sets.length)return studyWeakQuiz(sets[0].id);return toast('No weak quiz saved yet','error')}
function startWeakRetest(){const sets=weakQuizSets();if(sets.length)return startWeakQuiz(sets[0].id);return toast('No weak quiz to retest yet','error')}
function startRevisionQuiz(quiz,title){
  if(!quiz||!quiz.length)return toast('No quiz questions found','error');
  state.quiz=cloneQuizForRevision(quiz);state.answered={};state.submitted=false;state.lastResult=null;state.sessionId=null;state.activeAssignmentMeta=null;state.filter='all';
  if($('#quizTitle'))$('#quizTitle').value=title||'Revision Practice Quiz';
  $('#scorePanel')?.classList.remove('show');startTimer();if(typeof showPanel==='function')showPanel('generatePanel');if(typeof focusQuizMode==='function')focusQuizMode(true);renderQuiz();toast('Revision quiz started','success')
}
function startActiveRevisionAsTest(){const deck=activeRevisionDeck();if(!deck.length)return toast('Open or save a revision set first','error');startRevisionQuiz(deck,activeRevisionTitle())}
function downloadActiveRevisionPDF(){const deck=activeRevisionDeck();if(!deck.length)return toast('Open or save a revision set first','error');downloadRevisionQuizPDF(activeRevisionTitle(),deck,'Revision Practice Pack')}
function downloadRevisionQuizPDF(title,quiz,sub){
  const clean=cloneQuizForRevision(quiz);if(!clean.length)return toast('No questions to export','error');
  const items=[{header:true,title:'AI QUIZ GENERATOR',sub:sub||'Revision Studio Pack'},{box:['Saved revision set: '+(title||'Revision Practice'),'Total questions: '+clean.length,'Created: '+new Date().toLocaleString()]},{section:'Questions'}];
  clean.forEach((q,i)=>{items.push({text:(i+1)+'. '+q.question,size:10,bold:true});(q.options||[]).forEach((op,j)=>items.push({text:String.fromCharCode(65+j)+'. '+op,size:9,indent:16}));items.push({text:'Correct answer: '+q.correct,size:9,bold:true,indent:16,color:'0.05 0.32 0.18'},{gap:4})});
  downloadPDF(cleanFileName(title||'revision-pack')+'-revision-pack.pdf',items)
}
function prevCard(){toast('Use Study to preview the selected revision set','success')}
function flipCard(){toast('Answers are shown in the practice preview','success')}
function nextCard(){toast('Use Start as test for full practice','success')}
async function buildRevisionPlan(showToast=true){
  const goal=(revisionDom('revPlanGoal')?.value||'Focused revision').trim();const days=Math.min(14,Math.max(3,Number(revisionDom('revPlanDays')?.value||7)));const total=activeRevisionDeck().length;const weak=weakQuizSets().length;
  const box=revisionDom('revisionPlan');if(!box)return;
  let steps=[];try{const p=await request('/api/v1/revision/plans/generate',{method:'POST',body:JSON.stringify({title:goal,target_pct:80,days})});steps=(p.steps||[]).map(x=>['Day '+x.day,x.action+' — '+x.topic+' ('+x.minutes+' min)'])}catch(e){}
  if(!steps.length)steps=[['Day 1','Review saved quiz questions and read correct answers slowly.'],['Day 2','Start the same quiz without looking at answers.'],['Day 3',weak?'Open Auto Weak Revision Desk and repair low-score quizzes.':'Create one short personal quiz and submit it for baseline.'],['Day 4','Rewrite weak concepts as short private notes.'],['Day 5','Retake one saved set and compare your result.'],['Day 6','Download PDF and revise offline for 20 minutes.'],['Day 7','Final retake: aim for 75%+ before moving to the next topic.']].slice(0,days);
  box.innerHTML=steps.map(x=>`<div class="rev-plan-item"><span class="rev-label">${safe(x[0])}</span><b>${safe(x[1])}</b></div>`).join('')+`<div class="rev-empty" style="min-height:70px"><div><b>${safe(goal)}</b>${total} questions selected · ${weak} weak quizzes saved</div></div>`;
  if(showToast)toast('Revision plan refreshed','success')
}
function exportRevisionPack(){downloadText('revision_studio_pack.json',JSON.stringify({activeTitle:activeRevisionTitle(),activeQuiz:activeRevisionDeck(),savedSets:revisionSets(),weakQuizSets:weakQuizSets(),savedNotes:revisionNotesList(),profile:profileDetails(),exportedAt:new Date().toISOString()},null,2))}
function downloadText(name,text,type='application/json'){const blob=new Blob([text],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),700)}
function cleanFileName(v){return String(v||'academic-file').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'academic-file'}
function pdfSafe(v){return String(v??'').replace(/[•·]/g,'-').replace(/[–—]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[^\x09\x0A\x0D\x20-\x7E]/g,' ').replace(/\s+/g,' ').trim()}
function pdfEscape(v){return pdfSafe(v).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')}
function pdfWrap(text,max){const words=pdfSafe(text).split(' ').filter(Boolean),lines=[];let line='';words.forEach(w=>{if((line+' '+w).trim().length>max&&line){lines.push(line);line=w}else line=(line+' '+w).trim()});if(line)lines.push(line);return lines.length?lines:['']}

function downloadPDF(name,items){
  const W=595,H=842,margin=42;let pages=[[]],y=790;
  const add=o=>pages[pages.length-1].push(o);
  function addPage(){pages.push([]);y=790}
  function ensure(h=70){if(y<h+54)addPage()}
  function textLine(text,x,yy,size=10,bold=false,color='0.06 0.09 0.16'){add({type:'text',text:pdfSafe(text),x,y:yy,size,bold,color})}
  function line(x1,yy,x2,color='0.72 0.78 0.86',w=.8){add({type:'line',x1,y1:yy,x2,y2:yy,color,w})}
  function rect(x,yy,w,h,fill='0.95 0.98 1',stroke='0.75 0.84 0.95'){add({type:'rect',x,y:yy,w,h,fill,stroke})}
  function addText(text,size=10,bold=false,indent=0,gap=5,color='0.06 0.09 0.16'){
    const max=Math.max(30,Math.floor((W-margin*2-indent)/(size*.52)));
    pdfWrap(text,max).forEach(l=>{ensure(size+gap+10);textLine(l,margin+indent,y,size,bold,color);y-=size+gap});
  }
  function header(title,sub){ensure(96);rect(34,750,527,58,'0.04 0.09 0.17','0.04 0.09 0.17');textLine(title,52,785,11,true,'1 1 1');textLine(sub,52,766,22,true,'1 1 1');textLine('Generated: '+new Date().toLocaleString(),395,785,8,false,'0.78 0.88 1');y=724;line(margin,y,W-margin,'0.36 0.52 0.72',1.2);y-=18}
  function section(t){ensure(44);y-=4;textLine(String(t).toUpperCase(),margin,y,12,true,'0.02 0.18 0.32');y-=9;line(margin,y,W-margin,'0.74 0.82 0.92',.7);y-=15}
  function kv(rows){rows.forEach(([k,v])=>{ensure(30);textLine(String(k).toUpperCase(),margin,y,8,true,'0.38 0.45 0.56');textLine(String(v||'Not added'),margin+174,y,9,false,'0.06 0.09 0.16');y-=18});y-=4}
  function infoBox(lines){
    const rows=lines.map((l,i)=>{const size=i?9:10,indent=12;const max=Math.max(30,Math.floor((W-margin*2-indent-18)/(size*.52)));return{list:pdfWrap(l,max),size,bold:!i,color:i?'0.20 0.28 0.38':'0.02 0.18 0.32'}});
    const h=32+rows.reduce((n,r)=>n+r.list.length*(r.size+4),0);ensure(h+18);const bottom=y-h+8;rect(margin,bottom,W-margin*2,h,'0.97 0.99 1','0.74 0.84 0.95');y-=14;
    rows.forEach(r=>r.list.forEach(l=>{textLine(l,margin+12,y,r.size,r.bold,r.color);y-=r.size+4}));y=bottom-14;
  }
  items.forEach(it=>{if(it.header)return header(it.title||'AI QUIZ GENERATOR',it.sub||'Academic Document');if(it.section)return section(it.section);if(it.kv)return kv(it.kv);if(it.box)return infoBox(it.box);if(it.rule){line(margin,y,W-margin);y-=14;return}if(it.gap){y-=it.gap;if(y<58)addPage();return}addText(it.text||'',it.size||10,!!it.bold,it.indent||0,it.gapAfter??5,it.color||'0.06 0.09 0.16')});
  const obj=[];const pageIds=[];pages.forEach((p,i)=>{const content=p.map(o=>{if(o.type==='rect')return `${o.fill} rg ${o.x} ${o.y} ${o.w} ${o.h} re f\n${o.stroke} RG .7 w ${o.x} ${o.y} ${o.w} ${o.h} re S`;if(o.type==='line')return `${o.color} RG ${o.w} w ${o.x1} ${o.y1} m ${o.x2} ${o.y2} l S`;return `BT ${o.color} rg /F${o.bold?2:1} ${o.size} Tf 1 0 0 1 ${o.x} ${o.y} Tm (${pdfEscape(o.text)}) Tj ET`}).join('\n');const cid=5+i*2,pid=6+i*2;obj[cid]=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`;obj[pid]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`;pageIds.push(`${pid} 0 R`)});
  obj[1]='<< /Type /Catalog /Pages 2 0 R >>';obj[2]=`<< /Type /Pages /Kids [${pageIds.join(' ')}] /Count ${pageIds.length} >>`;obj[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';obj[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';let pdf='%PDF-1.4\n',offsets=[0];for(let i=1;i<obj.length;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${obj[i]}\nendobj\n`}const xref=pdf.length;pdf+=`xref\n0 ${obj.length}\n0000000000 65535 f \n`;for(let i=1;i<obj.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';pdf+=`trailer\n<< /Size ${obj.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([pdf],{type:'application/pdf'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),900)
}
function currentResultData(){if(state.lastResult)return state.lastResult;if(!state.quiz.length)return null;let score=0;const total=state.quiz.length;state.quiz.forEach((q,i)=>{if(q.options[state.answered[i]]===q.correct)score++});const answered=Object.keys(state.answered).length,wrong=state.quiz.reduce((n,q,i)=>n+(state.answered[i]!=null&&q.options[state.answered[i]]!==q.correct?1:0),0),skipped=total-answered,pct=total?Math.round(score/total*100):0;return {score,total,answered,wrong,skipped,pct,title:$('#quizTitle').value.trim()||'Practice Quiz',time:$('#timerBadge').textContent||'00:00',at:new Date().toLocaleString(),comparison:null}}
function academicRows(){const p=profileDetails();return [['Student Name',p.fullName||SESSION?.username||'Student'],['Roll No / Student ID',p.academicId||'Not added'],['University / Institute',p.institute||'Not added'],['Department',p.department||'Not added'],['Class / Semester',p.class||'Not added'],['Email',p.email||SESSION?.email||'Not added']]}
function downloadResultPDF(){
  const r=currentResultData();if(!r)return toast('Submit a quiz first to download result PDF','error');
  const items=[{header:true,title:'AI QUIZ GENERATOR',sub:'Official Academic Result Card'},{box:['Document Purpose: Professional academic result record for quiz performance, review, and student progress tracking.','Status: '+(r.answered===r.total?'Completed Attempt':'Partially Attempted')+'   Final Score: '+r.pct+'%']},{section:'Student Academic Profile'},{kv:academicRows()},{section:'Result Summary'},{kv:[['Quiz Title',r.title],['Attempt Date',r.at],['Time Taken',r.time],['Final Score',r.pct+'%'],['Correct Answers',r.score+'/'+r.total],['Wrong Answers',r.wrong],['Skipped Questions',r.skipped],['Answered Questions',r.answered+'/'+r.total]]}];
  if(r.comparison){items.push({section:'Retake Comparison'},{kv:[['Previous Score',r.comparison.previousPct+'%'],['Current Score',r.comparison.currentPct+'%'],['Change',formatSigned(r.comparison.diff)+'%'],['Status',r.comparison.status],['Previous Marks',r.comparison.previousMarks],['Current Marks',r.comparison.currentMarks]]},{box:['Retake Review: '+r.comparison.message]})}
  items.push({box:['Academic Review Focus: '+resultAdvice(r.pct,r.wrong,r.skipped)]},{section:'Answer Review'});
  state.quiz.forEach((q,i)=>{const selected=state.answered[i]!=null?q.options[state.answered[i]]:'Not answered';items.push({text:(i+1)+'. '+q.question,size:10,bold:true},{text:'Selected Answer: '+selected,size:9,indent:14},{text:'Correct Answer: '+q.correct,size:9,indent:14,color:'0.05 0.32 0.18'},{gap:4})});
  downloadPDF(cleanFileName(r.title)+'-academic-result-card.pdf',items)
}
function downloadMCQsPDF(){if(!state.quiz.length)return toast('Generate MCQs first','error');const title=$('#quizTitle').value.trim()||'Generated MCQ Practice';const p=profileDetails();const items=[{header:true,title:'AI QUIZ GENERATOR',sub:'Professional MCQ Practice Pack'},{box:['Study Pack Purpose: Downloadable MCQs for offline study, revision, classroom preparation, and academic practice.','This PDF includes complete questions, all options, and a clean answer key without requiring a quiz attempt.']},{section:'Academic Study Pack Details'},{kv:[['Student Name',p.fullName||SESSION?.username||'Student'],['Roll No / Student ID',p.academicId||'Not added'],['University / Institute',p.institute||'Not added'],['Department',p.department||'Not added'],['Class / Semester',p.class||'Not added'],['Quiz Title',title],['Total MCQs',state.quiz.length],['Source Type',state.source==='pdf'?'PDF Source':'Text Notes']]},{section:'MCQs With Options'}];state.quiz.forEach((q,i)=>{items.push({text:(i+1)+'. '+q.question,size:10,bold:true});q.options.forEach((op,j)=>items.push({text:String.fromCharCode(65+j)+'. '+op,size:9,indent:16}));items.push({gap:4})});items.push({section:'Answer Key'});state.quiz.forEach((q,i)=>items.push({text:(i+1)+'. '+q.correct,size:9,bold:true}));items.push({box:['Revision Note: Attempt these MCQs first without checking the key, then review weak questions and repeat the test for better retention.']});downloadPDF(cleanFileName(title)+'-professional-mcq-pack.pdf',items)}
function downloadQuizJSON(){downloadMCQsPDF()}
function downloadResultJSON(){downloadResultPDF()}
function openSettings(){renderSettings();$('#settingsModal').classList.add('show')}
function closeSettings(){$('#settingsModal').classList.remove('show')}
function renderSettings(){
  const p=readJSON('aqg_prefs',{});
  const unlocked=localStorage.getItem('aqg_owner_unlocked')==='1';
  const role=getRole();
  const allowed=(NAV[role]||[]).map(n=>({id:n[0],label:n[1]}));
  const savedStart=(p.startPage&&p.startPage[role])||defaultPanel();
  const startOptions=allowed.map(x=>`<option value="${safe(x.id)}" ${x.id===savedStart?'selected':''}>${safe(x.label)}</option>`).join('');

  $('#settingsBody').innerHTML=`
    <div class="settings-grid">
      <div class="setting">
        <span class="badge brand">Appearance</span>
        <h3>Theme</h3>
        <div class="choice-grid">
          <button class="choice ${p.theme!=='light'?'active':''}" onclick="setTheme('dark')">Dark<small>Premium default</small></button>
          <button class="choice ${p.theme==='light'?'active':''}" onclick="setTheme('light')">Light<small>Clean classroom</small></button>
          <button class="choice" onclick="setTheme('dark')">Focus<small>Dark focused</small></button>
        </div>
      </div>

      <div class="setting">
        <span class="badge brand">Backend</span>
        <h3>Owner protected API</h3>
        <p class="muted">Normal users cannot change backend connection.</p>
        ${unlocked
          ? `<input id="apiInput" class="input" value="${safe(API)}" placeholder="http://127.0.0.1:8000"><button class="btn primary" style="margin-top:10px" onclick="saveApi()">Save endpoint</button>`
          : `<button class="btn ghost" onclick="ownerUnlock()">Developer unlock</button>`}
      </div>

      <div class="setting">
        <span class="badge brand">Workspace</span>
        <h3>Startup page</h3>
        <p class="muted">Choose which section should open first for this portal.</p>
        <select id="startupPageSelect" class="select">${startOptions}</select>
        <button class="btn primary" style="margin-top:10px" onclick="saveStartupPage()">Save startup page</button>
      </div>

      <div class="setting">
        <span class="badge brand">Profile</span>
        <h3>Clear profile details</h3>
        <p class="muted">Removes locally saved profile information only. Classes, assessments, attempts and results stay safe.</p>
        <button class="btn danger" onclick="clearProfileDetails()">Clear profile details</button>
      </div>
    </div>`}
function setTheme(t){const p=readJSON('aqg_prefs',{});p.theme=t;writeJSON('aqg_prefs',p);applyTheme();renderSettings()}
function saveStartupPage(){
  const id=$('#startupPageSelect')?.value;
  if(!isPanelAllowed(id)){
    toast('Choose a valid startup page','error');
    return;
  }
  const p=readJSON('aqg_prefs',{});
  p.startPage=p.startPage||{};
  p.startPage[getRole()]=id;
  writeJSON('aqg_prefs',p);
  localStorage.setItem(activePanelKey(),id);
  toast('Startup page saved','success');
  renderSettings();
}
function clearProfileDetails(){
  if(!confirm('Clear locally saved profile details? Classes, assessments and results will not be deleted.'))return;
  localStorage.removeItem(profileKey());
  paintUser();
  if(getRole()==='teacher')loadTeacherProfile(false);
  else loadProfile(false);
  toast('Profile details cleared','success');
}

function ownerUnlock(){const code=prompt('Owner code');if(code==='MSJ-ADMIN-2026'){localStorage.setItem('aqg_owner_unlocked','1');toast('Owner controls unlocked','success');renderSettings()}else toast('Wrong owner code','error')}
function saveApi(){API=$('#apiInput').value.trim().replace(/\/+$/,'');localStorage.setItem('aqg_api_base',API);toast('Backend endpoint saved','success');checkHealth()}
async function repairRole(){if(!SESSION)return;try{const d=await request('/auth/me');SESSION={...SESSION,...d};localStorage.setItem(roleCacheKey(SESSION.user_id),SESSION.role);persistSession();renderForRole();toast('Account role refreshed securely','success')}catch(e){toast(e.message,'error')}}
function clearLocalProfile(){localStorage.removeItem(profileKey());paintUser();loadProfile(false);toast('Local profile cleared','success')}


/* ASSIGNMENT CLASS-FIRST WORKSPACE LOGIC UPDATE */
function assignmentSubmissionsKey(code){return 'aqg_assignment_submissions_'+String(code||'').trim().toUpperCase()}
function activeAssignmentMetaForAttempt(){return state.currentSessionAssignmentMeta||currentAssignmentHistoryMeta()||(state.sessionId?historyIdentityMap()[String(state.sessionId)]:null)||null}
function saveHistoryIdentityForCurrentSession(){
  state.currentSessionAssignmentMeta=null;
  if(!state.sessionId)return null;
  const teacherMeta=currentAssignmentHistoryMeta();
  if(teacherMeta){saveHistoryIdentity(state.sessionId,teacherMeta);state.currentSessionAssignmentMeta=teacherMeta;return teacherMeta}
  if(!state.retakeContext){
    const selfMeta={origin:'self',sourceLabel:'Self-created Practice',assignmentTitle:$('#quizTitle')?.value?.trim()||'Practice quiz',classCode:'',className:'Own Practice',teacherName:'Self-created',subject:'Personal Study',due:'',questionCount:getCount(),createdFrom:'Generate Quiz workspace'};
    saveHistoryIdentity(state.sessionId,selfMeta);state.currentSessionAssignmentMeta=selfMeta;return selfMeta
  }
  return null
}
function storeLocalAttempt(score,total,pct,comparison=null){
  const meta=activeAssignmentMetaForAttempt();
  const item={score,total,pct,at:new Date().toISOString(),title:$('#quizTitle').value.trim()||'Untitled quiz',sessionId:state.sessionId||null,comparison:comparison||null,meta:meta||null,assignmentId:meta?.assignmentId||null,classCode:meta?.classCode||'',className:meta?.className||'',teacherName:meta?.teacherName||'',subject:meta?.subject||''};
  const arr=readJSON(attemptsKey(),[]);arr.push(item);writeJSON(attemptsKey(),arr);
  if(state.sessionId){const s=readSessionAttempts(state.sessionId);s.push(item);writeJSON(sessionAttemptsKey(state.sessionId),s)}
  if(meta&&meta.origin==='teacher'&&meta.classCode){
    const p=profileDetails(),std=studentAccessCode();
    const rows=readJSON(assignmentSubmissionsKey(meta.classCode),[]);
    rows.push({id:Date.now(),assignmentId:meta.assignmentId||null,assignmentTitle:meta.assignmentTitle||item.title,classCode:meta.classCode,className:meta.className||'',teacherCode:meta.teacherCode||'',teacherName:meta.teacherName||'',subject:meta.subject||'',studentUserId:SESSION?.user_id||'',studentName:p.fullName||SESSION?.username||'Student',studentEmail:p.email||SESSION?.email||'',studentCode:std,score,total,pct,answered:state.lastResult?.answered??Object.keys(state.answered||{}).length,submittedAt:new Date().toISOString(),time:state.lastResult?.time||$('#timerBadge')?.textContent||'00:00',sessionId:state.sessionId||null});
    writeJSON(assignmentSubmissionsKey(meta.classCode),rows.slice(-500));
  }
}
function currentSelectedTeacherAssignmentClass(){
  const classes=ensureTeacherClasses();
  let code=String(state.activeTeacherAssignmentsClassCode||profileDetails().activeClassCode||activeTeacherClassCode()||'').toUpperCase();
  if(!classes.some(c=>c.code===code))code=classes[0]?.code||'';
  state.activeTeacherAssignmentsClassCode=code;
  return code
}
function teacherSubmittedAssignmentsFor(classCode,assignmentId=''){
  classCode=String(classCode||'').toUpperCase();assignmentId=String(assignmentId||'');
  const direct=readJSON(assignmentSubmissionsKey(classCode),[]).filter(x=>!assignmentId||String(x.assignmentId)===assignmentId);
  const extra=[];
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i)||'';if(!k.startsWith('aqg_attempts_'))continue;
      let rows=[];try{rows=JSON.parse(localStorage.getItem(k)||'[]')}catch(e){rows=[]}
      if(!Array.isArray(rows))continue;
      rows.forEach(a=>{const m=a.meta||{};if(String(m.classCode||a.classCode||'').toUpperCase()===classCode&&(!assignmentId||String(m.assignmentId||a.assignmentId||'')===assignmentId))extra.push({...a,assignmentId:m.assignmentId||a.assignmentId,assignmentTitle:m.assignmentTitle||a.title,classCode:m.classCode||a.classCode,pct:a.pct,score:a.score,total:a.total,submittedAt:a.at,studentName:a.studentName||'Student',studentEmail:a.studentEmail||'',studentCode:a.studentCode||''})})
    }
  }catch(e){}
  const map=new Map();[...direct,...extra].forEach(x=>{const key=[x.assignmentId||'',x.studentCode||x.studentEmail||x.studentUserId||x.sessionId||Math.random(),x.submittedAt||x.at||''].join('|');if(!map.has(key))map.set(key,x)});
  return [...map.values()].sort((a,b)=>new Date(b.submittedAt||b.at||0)-new Date(a.submittedAt||a.at||0))
}
function uniqueSubmissionStudents(rows){const set=new Set();(rows||[]).forEach(r=>set.add(String(r.studentCode||r.studentEmail||r.studentUserId||r.studentName||Math.random()).toLowerCase()));return set.size}
function avgSubmissionPct(rows){rows=(rows||[]).filter(r=>Number.isFinite(Number(r.pct)));return rows.length?Math.round(rows.reduce((s,r)=>s+Number(r.pct),0)/rows.length):0}
function selectTeacherAssignmentClass(code){$('#teacherAssignmentsPanel')?.classList.remove('inline-preview-open');const box=$('#teacherInlineAssignmentPreview');if(box)box.innerHTML='';state.activeTeacherAssignmentsClassCode=String(code||'').toUpperCase();renderTeacherAssignments()}
function teacherAssignToClass(code){
  code=String(code||currentSelectedTeacherAssignmentClass()).toUpperCase();
  if(!code)return toast('Create/select a class first','error');
  state.activeTeacherAssignmentsClassCode=code;
  const d={...profileDetails(),activeClassCode:code};writeJSON(profileKey(),d);
  renderTeacherClassSelect();
  const sel=$('#taClassSelect');if(sel){sel.value=code;sel.dispatchEvent(new Event('change'))}
  showPanel('teacherQuizPanel')
}
function teacherAssignToSelectedClass(){teacherAssignToClass(currentSelectedTeacherAssignmentClass())}
function createAssignment(){
  const arr=ensureTeacherClasses();const selected=String($('#taClassSelect')?.value||activeTeacherClassCode()).toUpperCase();const cls=arr.find(c=>c.code===selected)||arr[0];
  if(!cls)return toast('Create a class first','error');
  const content=$('#taContent').value.trim();if(content.length<50)return toast('Add at least 50 characters of source content','error');
  publishTeacherDirectory(arr);const meta=teacherClassMeta(cls.code),d=profileDetails();
  const a={id:Date.now(),teacherId:SESSION.user_id,teacherCode:teacherCode(),teacherName:meta.teacherName||d.fullName||SESSION.username,classCode:cls.code,className:cls.className,teacherSubject:d.teacherSubject||meta.subject||'General',teacherInstitute:d.institute||'',teacherDepartment:d.department||'',title:$('#taTitle').value.trim()||'Untitled quiz',subject:$('#taSubject').value.trim()||cls.subject||d.teacherSubject||'General',due:$('#taDue').value,instructions:$('#taInstructions').value.trim(),count:Math.max(1,Math.min(250,parseInt($('#taCount').value||10,10))),content,createdAt:new Date().toISOString()};
  const mine=readJSON(assignmentsKey(),[]);mine.push(a);writeJSON(assignmentsKey(),mine);
  const classRows=readJSON(classAssignmentsKey(cls.code),[]);classRows.push(a);writeJSON(classAssignmentsKey(cls.code),classRows);
  state.activeTeacherAssignmentsClassCode=cls.code;writeJSON(profileKey(),{...profileDetails(),activeClassCode:cls.code});
  ['#taTitle','#taSubject','#taDue','#taInstructions','#taContent'].forEach(id=>{const el=$(id);if(el)el.value=''});
  renderTeacherAssignments();renderTeacherDashboard();toast('Assignment saved for '+a.className+' · '+a.classCode,'success');showPanel('teacherAssignmentsPanel')
}
function renderTeacherAssignments(){
  const out=$('#teacherAssignmentsOut');if(!out)return;
  const classes=ensureTeacherClasses(),active=currentSelectedTeacherAssignmentClass(),activeMeta=teacherClassMeta(active),allRows=readJSON(assignmentsKey(),[]).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)),rows=allRows.filter(a=>String(a.classCode||'').toUpperCase()===active),students=readJSON(studentsKey(active),[]),subAll=teacherSubmittedAssignmentsFor(active),set=(id,v)=>{const el=$('#'+id);if(el)el.textContent=v};
  set('teacherAssignmentClassBadge',classes.length+' class'+(classes.length===1?'':'es'));set('teacherAssignmentListBadge',rows.length+' assessments');
  const classList=$('#teacherAssignmentClassList');
  if(classList)classList.innerHTML=classes.length?classes.map(c=>{const code=String(c.code).toUpperCase(),ass=readJSON(classAssignmentsKey(code),[]),subs=teacherSubmittedAssignmentsFor(code),std=readJSON(studentsKey(code),[]),pct=ass.length?Math.round((subs.length/Math.max(1,ass.length*Math.max(1,std.length||1)))*100):0;return `<div class="assignment-pro-class-card ${code===active?'active':''}"><div><span class="class-kicker">Teacher class</span><div class="class-title">${safe(c.className||'Academic Class')}</div><div class="class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span><span class="badge">Key: ${safe(c.classKey||'-')}</span></div></div><div class="assignment-mini-stats"><div><span>Students</span><b>${std.length}</b></div><div><span>Assessments</span><b>${ass.length}</b></div><div><span>Progress</span><b>${pct}%</b></div></div><div class="class-actions"><button class="btn primary small" onclick="selectTeacherAssignmentClass('${safe(code)}')">Open class</button><button class="btn ghost small" onclick="teacherAssignToClass('${safe(code)}')">Create</button></div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No class yet</h3><p>Create classes first from Classes.</p></div>`;
  const title=$('#teacherAssignmentWorkspaceTitle'),hint=$('#teacherAssignmentWorkspaceHint');
  if(title)title.textContent=(activeMeta.className||'Selected class')+' progress';
  if(hint)hint.textContent=`${students.length} student${students.length===1?'':'s'} · ${rows.length} assessment${rows.length===1?'':'s'} · ${subAll.length} submission${subAll.length===1?'':'s'}`;
  const prog=$('#teacherAssignmentProgressOut'),possible=rows.length*Math.max(1,students.length||1),overall=possible?Math.min(100,Math.round(subAll.length/possible*100)):0,avg=avgSubmissionPct(subAll);
  if(prog)prog.innerHTML=`<div class="assignment-progress-summary"><div><span>Students</span><b>${students.length}</b></div><div><span>Assessments</span><b>${rows.length}</b></div><div><span>Submissions</span><b>${subAll.length}</b></div><div><span>Average</span><b>${avg}%</b></div></div>${rows.length?rows.map(a=>{const subs=teacherSubmittedAssignmentsFor(active,a.id),unique=uniqueSubmissionStudents(subs),den=Math.max(1,students.length||1),pct=Math.min(100,Math.round(unique/den*100));return `<div class="assignment-progress-row"><div><span>${safe(a.subject||activeMeta.subject||'General')}</span><h3>${safe(a.title)}</h3><p>${unique}/${students.length||0} students submitted · ${subs.length} total attempt${subs.length===1?'':'s'} · Due ${safe(a.due||'No due date')}</p><div class="assignment-progress-bar"><div style="width:${pct}%"></div></div></div><div class="assignment-progress-pct">${pct}%</div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No assessments yet</h3><p>Press Create assessment to publish work for this selected class.</p></div>`}`;
  out.innerHTML=rows.length?rows.map(a=>{const meta=teacherClassMeta(a.classCode),subs=teacherSubmittedAssignmentsFor(a.classCode,a.id),unique=uniqueSubmissionStudents(subs),avg=avgSubmissionPct(subs);return `<div class="assignment-pro-card"><div><span class="assignment-class-title">${safe(meta.className)} · ${safe(a.classCode)}</span><h3>${safe(a.title)}</h3><p class="muted">${safe(a.subject||meta.subject||'General')} · ${a.count} questions · ${unique} submitted · avg ${avg}%</p><div class="assignment-pro-meta"><span class="badge brand">Class: ${safe(meta.className)}</span><span class="badge">Due: ${safe(a.due||'No due date')}</span><span class="badge">${a.timeLimitMinutes?safe(a.timeLimitMinutes)+' min':'No timer'}</span><span class="badge ${a.allowRetake===false?'warn':'good'}">${a.allowRetake===false?'One attempt':'Retake allowed'}</span><span class="badge good">${subs.length} attempt${subs.length===1?'':'s'}</span></div><div class="assignment-pro-note"><b>Instructions</b>${safe(a.instructions||'No extra instructions')}</div></div><div class="assignment-pro-actions"><button class="btn ghost small" onclick="previewAssignment(${a.id})">Preview</button><button class="btn danger small" onclick="deleteAssignment(${a.id})">Delete</button></div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No assessment in this class</h3><p>${safe(activeMeta.className||'This class')} has no published work yet.</p><button class="btn primary small" style="margin-top:12px" onclick="teacherAssignToSelectedClass()">Create assessment</button></div>`
}
function studentAssignmentSubmissions(classCode='',assignmentId=''){
  classCode=String(classCode||'').toUpperCase();assignmentId=String(assignmentId||'');
  const std=normalizeStudentApprovalKey(studentAccessCode()),email=String(SESSION?.email||'').toLowerCase(),uid=String(SESSION?.user_id||''),rows=[];
  const add=r=>{const m=r.meta||r;const code=String(m.classCode||r.classCode||'').toUpperCase();if(classCode&&code!==classCode)return;const aid=String(m.assignmentId||r.assignmentId||'');if(assignmentId&&aid!==assignmentId)return;const belongs=!r.studentUserId&&!r.studentCode&&!r.studentEmail&&String(r.title||'')||String(r.studentUserId||'')===uid||normalizeStudentApprovalKey(r.studentCode||'')===std||String(r.studentEmail||'').toLowerCase()===email||String(r.sessionOwner||'')===uid;if(!belongs)return;rows.push({...r,meta:m,assignmentId:aid,assignmentTitle:m.assignmentTitle||r.assignmentTitle||r.title,classCode:code,className:m.className||r.className,teacherName:m.teacherName||r.teacherName,pct:r.pct,score:r.score,total:r.total,submittedAt:r.submittedAt||r.at})};
  readJSON(assignmentSubmissionsKey(classCode),[]).forEach(add);
  readJSON(attemptsKey(),[]).forEach(add);
  const map=new Map();rows.forEach(r=>{const key=[r.assignmentId||'',r.sessionId||'',r.submittedAt||r.at||'',r.pct].join('|');if(!map.has(key))map.set(key,r)});
  return [...map.values()].sort((a,b)=>new Date(b.submittedAt||b.at||0)-new Date(a.submittedAt||a.at||0))
}
function renderStudentAssignmentClassCard(c,active,forAssignments=false){
  const code=String(c.code).toUpperCase(),joined=c.status==='joined',rows=readJSON(classAssignmentsKey(code),[]),subs=studentAssignmentSubmissions(code),isActive=active===code;
  return `<div class="assignment-pro-class-card ${isActive?'active':''}"><div><span class="class-kicker">${joined?'Joined class':'Teacher approved'}</span><div class="class-title">${safe(c.className||'Academic Class')}</div><div class="class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">Teacher: ${safe(c.teacherName||'Teacher')}</span><span class="badge">${rows.length} assignment${rows.length===1?'':'s'}</span>${joined?'<span class="badge good">Joined</span>':'<span class="badge warn">Not joined</span>'}</div></div><div class="assignment-mini-stats"><div><span>Assessments</span><b>${rows.length}</b></div><div><span>Submitted</span><b>${subs.length}</b></div><div><span>Subject</span><b>${safe(c.subject||'General')}</b></div></div><div class="class-actions">${joined?`<button class="btn primary small" onclick="openStudentClassAssignments('${safe(code)}')">Open</button>${forAssignments?`<button class="btn ghost small" onclick="showPanel('studentClassesPanel')">Classes</button>`:`<button class="btn danger small" onclick="leaveStudentClass('${safe(code)}')">Remove</button>`}`:`<button class="btn primary small" onclick="joinApprovedStudentClass('${safe(code)}')">Join</button><button class="btn ghost small" onclick="showPanel('studentClassesPanel')">Open classes</button>`}</div></div>`
}
function renderStudentAssignments(){
  const out=$('#studentAssignmentsOut');if(!out)return;
  const d=profileDetails(),codes=studentJoinedCodes(),classes=studentClassRows(),joinedClasses=classes.filter(c=>c.status==='joined'),allRows=getStudentAssignments(),total=allRows.reduce((s,a)=>s+(parseInt(a.count,10)||0),0),stdCode=studentAccessCode(),approvedOnly=classes.filter(c=>c.status==='approved').length,set=(id,v)=>{const el=$('#'+id);if(el)el.textContent=v};
  set('asClassCode',codes.length?codes.length+' joined':'0 joined');set('asTotal',allRows.length);set('asQuestions',total);set('asStudentCode',stdCode);set('asStudentAccessCode',stdCode);set('asJoinedCount',codes.length+' joined'+(approvedOnly?' · '+approvedOnly+' approved':''));set('saClassCount',codes.length?codes.length+' joined':'0');set('saAssignmentTotal',allRows.length);set('saQuestionTotal',total);
  const inp=$('#joinClassCode');if(inp)inp.placeholder='Teacher code or class code: TCH-AB12 / CLS-1234';
  const chip=$('#asCurrentClass');if(chip)chip.innerHTML=codes.length?`Connected to <b>${safe(codes.length+' joined class'+(codes.length>1?'es':''))}</b>${approvedOnly?' · '+approvedOnly+' approved pending':''}`:(approvedOnly?`<b>${approvedOnly} approved class${approvedOnly>1?'es':''}</b> waiting to join`:'No teacher class connected');
  let active=String(state.activeStudentClassCode||'').toUpperCase();
  if(active&&!classes.some(c=>String(c.code).toUpperCase()===active))active='';
  if(!active)active=joinedClasses[0]?.code||classes[0]?.code||'';
  state.activeStudentClassCode=active;
  const classBoard=$('#asClassList');if(classBoard)classBoard.innerHTML=classes.length?classes.map(c=>renderStudentAssignmentClassCard(c,active,false)).join(''):`<div class="assign-class-empty"><b>No class found yet.</b><br>Enter teacher code to view all classes, class code to view one class, or ask teacher to approve your student key.</div>`;
  const assClassList=$('#studentAssignmentsClassList');if(assClassList)assClassList.innerHTML=joinedClasses.length?joinedClasses.map(c=>renderStudentAssignmentClassCard(c,active,true)).join(''):`<div class="assignment-empty-slim"><h3>No joined classes</h3><p>Open Classes section, join your correct class, then assessments will appear here class-wise.</p><button class="btn primary small" style="margin-top:12px" onclick="showPanel('studentClassesPanel')">Join class</button></div>`;
  set('studentAssignmentClassBadge',joinedClasses.length+' joined');
  const activeMeta=classes.find(c=>String(c.code).toUpperCase()===active)||null,activeJoined=active&&codes.includes(active),rows=activeJoined?getStudentAssignments(active):[],submitted=activeJoined?studentAssignmentSubmissions(active):[];
  set('asListBadge',activeJoined?rows.length+' active':(activeMeta?'Join class':'0 active'));set('saActiveClass',activeMeta?(activeMeta.className||activeMeta.code||'Class'):'None');set('studentAssignmentSubmittedBadge',submitted.length+' submitted');
  const title=$('#studentAssignmentDetailTitle'),hint=$('#studentAssignmentDetailHint'),subTitle=$('#studentSubmittedTitle');
  if(title)title.textContent=activeMeta?`${activeMeta.className||'Class'} assessments`:'Class assessments';
  if(hint)hint.textContent=activeMeta?(activeJoined?'Active assessments from this selected class are shown below.':'This class is approved. Join it first to open assessments.'):'Select a joined class first.';
  if(subTitle)subTitle.textContent=activeMeta?`${activeMeta.className||'Class'} submitted work`:'Submitted assessments';
  const info=$('#asStudentBox');if(info){const p=[['Student',d.fullName||SESSION.username||'Student'],['Student key',stdCode],['Roll / ID',d.academicId||d.studentId||d.academicId||'Not added'],['Institute',d.institute||d.university||'Not added'],['Department',d.department||'Not added']];info.innerHTML=p.map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}
  const flow=$('#asFlowBox');if(flow)flow.innerHTML=[['Teacher code','Shows all classes from one teacher.'],['Class code','Shows only that one class.'],['Assignments','Open class from Assignments to view active and submitted work.']].map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('');
  if(!activeMeta){out.innerHTML=`<div class="assignment-empty-slim"><h3>No class selected</h3><p>Join a class first, then class assessments will appear here.</p></div>`}else if(!activeJoined){out.innerHTML=`<div class="assignment-empty-slim"><h3>${safe(activeMeta.className||'Approved class')}</h3><p>Join this approved class first, then assessments will appear here.</p><button class="btn primary small" style="margin-top:12px" onclick="joinApprovedStudentClass('${safe(active)}')">Join approved class</button></div>`}else if(!rows.length){out.innerHTML=`<div class="assignment-empty-slim"><h3>No active assessments</h3><p>${safe(activeMeta.teacherName||'Teacher')} has not assigned work to ${safe(activeMeta.className||'this class')} yet.</p></div>`}else{out.innerHTML=rows.map((a,i)=>{const due=a.due?new Date(a.due).toLocaleDateString():'No due date',ins=a.instructions||'No extra instructions from teacher.',code=a.joinedClassCode||a.classCode||'Class',meta=teacherClassMeta(code),className=a.className||meta.className,teacher=a.teacherName||meta.teacherName,done=studentAssignmentSubmissions(code,a.id).length;return `<div class="assignment-pro-card"><div><span>Assessment ${rows.length-i} · ${safe(className)}</span><h3>${safe(a.title)}</h3><p class="muted">${safe(a.subject||meta.subject||'General')} · ${a.count} MCQs · Teacher: ${safe(teacher)}</p><div class="assignment-pro-meta"><span class="badge brand">Code: ${safe(code)}</span><span class="badge">Due: ${safe(due)}</span><span class="badge">${a.timeLimitMinutes?safe(a.timeLimitMinutes)+' min':'No timer'}</span><span class="badge ${a.allowRetake===false?'warn':'good'}">${a.allowRetake===false?'One attempt':'Retake allowed'}</span>${done?`<span class="badge good">Submitted ${done}</span>`:'<span class="badge warn">Pending</span>'}</div><div class="assignment-pro-note"><b>Teacher instructions</b>${safe(ins)}</div></div><div class="assignment-pro-actions"><button class="btn primary small" onclick="startAssignment(${a.id})">Open quiz</button><button class="btn ghost small" onclick="showPanel('historyPanel')">Results</button></div></div>`}).join('')}
  const subOut=$('#studentSubmittedAssignmentsOut');if(subOut)subOut.innerHTML=submitted.length?submitted.map(r=>`<div class="submitted-assignment-card"><div><span>${safe(r.subject||r.meta?.subject||'Submitted assessment')}</span><h3>${safe(r.assignmentTitle||r.title||r.meta?.assignmentTitle||'Assessment attempt')}</h3><p>${safe(new Date(r.submittedAt||r.at||Date.now()).toLocaleString())} · ${safe(r.score??0)}/${safe(r.total??0)} correct · ${safe(r.time||'00:00')}</p></div><div class="submitted-score-pill">${safe(r.pct??0)}%</div></div>`).join(''):`<div class="assignment-empty-slim"><h3>No submitted assessments</h3><p>After submitting a quiz from this class, the completed attempt will appear here.</p></div>`
}
function startAssignment(id){
  const a=getStudentAssignments().find(x=>String(x.id)===String(id));if(!a)return;
  const code=a.joinedClassCode||a.classCode||'',meta=teacherClassMeta(code);
  state.currentSessionAssignmentMeta=null;
  state.activeAssignmentMeta={origin:'teacher',assignmentId:a.id,assignmentTitle:a.title,title:a.title,classCode:code,className:a.className||meta.className,teacherName:a.teacherName||meta.teacherName,teacherCode:a.teacherCode||meta.teacherCode||'',subject:a.subject||meta.subject||'General',due:a.due||'',instructions:a.instructions||'',count:a.count||getCount()};
  focusQuizMode(false);$('#quizTitle').value=a.title;$('#textData').value=a.content;$('#customCount').value=a.count;setSource('text');updateTextStats();showPanel('generatePanel');toast('Assignment loaded. Generate quiz, submit it, then it will appear in Submitted assignments.','success')
}



/* ASSIGNMENT-WISE CLASS ANALYTICS FIX: override analytics render so class -> assignments -> assignment students. */
function analyticsStudentKeysForMatch(obj){
  const keys=[];
  const add=v=>{v=String(v||'').trim();if(v&&!keys.includes(v))keys.push(v)};
  add(normalizeStudentApprovalKey(obj?.studentCode||obj?.studentKey||''));
  add(String(obj?.studentEmail||obj?.email||'').trim().toLowerCase());
  add(String(obj?.studentUserId||obj?.user_id||'').trim());
  return keys.filter(Boolean)
}
function analyticsRosterForAssignment(classCode,meta){
  classCode=String(classCode||'').toUpperCase();
  const joined=readJSON(studentsKey(classCode),[]).map(s=>({...s,rosterStatus:'Joined'}));
  const seen=new Set();
  joined.forEach(s=>analyticsStudentKeysForMatch(s).forEach(k=>seen.add(k)));
  const addPending=(value,type)=>{
    const raw=String(value||'').trim();if(!raw)return;
    const key=type==='email'?raw.toLowerCase():normalizeStudentApprovalKey(raw);
    if(!key||seen.has(key))return;
    seen.add(key);
    joined.push({fullName:'Approved student',username:'Approved student',studentCode:type==='code'?raw:'',studentEmail:type==='email'?raw:'',email:type==='email'?raw:'',rosterStatus:'Approved'})
  };
  (meta?.allowedStudents||[]).forEach(v=>addPending(v,'code'));
  (meta?.allowedEmails||[]).forEach(v=>addPending(v,'email'));
  return joined
}
function analyticsLatestSubmissionMap(rows){
  const map=new Map();
  (rows||[]).forEach(r=>{
    analyticsStudentKeysForMatch(r).forEach(k=>{if(!map.has(k))map.set(k,r)})
  });
  return map
}
function analyticsSubmissionForStudent(student,map){
  const keys=analyticsStudentKeysForMatch(student);
  for(const k of keys){if(map.has(k))return map.get(k)}
  return null
}
function analyticsOpenAssignment(code,id){
  state.activeAnalyticsClassCode=String(code||'').toUpperCase();
  state.activeAnalyticsAssignmentId=String(id||'');
  renderTeacherAnalytics()
}
function renderTeacherAnalytics(){
  const out=$('#teacherAnalyticsOut');if(!out)return;
  const classes=ensureTeacherClasses(),allAssignments=readJSON(assignmentsKey(),[]);
  let active=String(state.activeAnalyticsClassCode||activeTeacherClassCode()||classes[0]?.code||'').toUpperCase();
  if(active&&!classes.some(c=>String(c.code).toUpperCase()===active))active=String(classes[0]?.code||'').toUpperCase();
  state.activeAnalyticsClassCode=active;
  const activeMeta=classes.find(c=>String(c.code).toUpperCase()===active)||null;
  const activeAssignments=active?readJSON(classAssignmentsKey(active),[]):[];
  let activeAssignmentId=String(state.activeAnalyticsAssignmentId||'');
  if(!activeAssignments.some(a=>String(a.id)===activeAssignmentId))activeAssignmentId=activeAssignments[0]?String(activeAssignments[0].id):'';
  state.activeAnalyticsAssignmentId=activeAssignmentId;
  const activeAssignment=activeAssignments.find(a=>String(a.id)===activeAssignmentId)||null;
  const studentsTotal=classes.reduce((n,c)=>n+analyticsRosterForAssignment(c.code,c).length,0);
  const allSubs=classes.flatMap(c=>teacherSubmittedAssignmentsFor(String(c.code).toUpperCase()));
  const overallAvg=avgSubmissionPct(allSubs);

  const classCards=classes.length?classes.map(c=>{
    const code=String(c.code).toUpperCase(),students=analyticsRosterForAssignment(code,c),assignments=readJSON(classAssignmentsKey(code),[]),subs=teacherSubmittedAssignmentsFor(code),pct=avgSubmissionPct(subs),opened=code===active;
    return `<article class="ta-class-card ${opened?'active':''}"><div class="ta-class-top"><div><div class="ta-class-name">${safe(c.className||'Academic Class')}</div><div class="ta-class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span><span class="badge">Key: ${safe(c.classKey||'-')}</span></div></div>${opened?'<span class="badge good">Selected</span>':''}</div><div class="ta-class-stats"><div><span>Students</span><b>${students.length}</b></div><div><span>Assessments</span><b>${assignments.length}</b></div><div><span>Average</span><b>${pct}%</b></div></div><div class="ta-class-actions"><button class="btn primary small" onclick="openTeacherAnalyticsClass('${safe(code)}')">${opened?'Refresh class':'Open class'}</button><button class="btn ghost small" onclick="analyticsAssignToClass('${safe(code)}')">Create</button></div></article>`
  }).join(''):`<div class="assignment-empty-slim"><h3>No class available</h3><p>Create a class first, then analytics will appear here automatically.</p><button class="btn primary small" style="margin-top:10px" onclick="showPanel('teacherStudentsPanel')">Create class</button></div>`;

  let activeWorkspace='';
  if(activeMeta){
    const roster=analyticsRosterForAssignment(active,activeMeta),classSubs=teacherSubmittedAssignmentsFor(active),classAvg=avgSubmissionPct(classSubs);
    const assignmentItems=activeAssignments.length?activeAssignments.map(a=>{
      const subs=teacherSubmittedAssignmentsFor(active,a.id),subMap=analyticsLatestSubmissionMap(subs),submitted=roster.filter(st=>analyticsSubmissionForStudent(st,subMap)).length,pending=Math.max(0,roster.length-submitted),latest=roster.map(st=>analyticsSubmissionForStudent(st,subMap)).filter(Boolean),avg=avgSubmissionPct(latest),progress=roster.length?Math.round(submitted/roster.length*100):0,selected=String(a.id)===String(activeAssignmentId);
      return `<article class="ta-assignment-item ${selected?'active':''}"><div><span class="badge brand">${safe(assignmentTypeLabel(a))}</span><h4>${safe(a.title||'Untitled assessment')}</h4><p>${safe(a.subject||activeMeta.subject||'General')} · Due ${safe(a.due||'No due date')}</p></div><div class="ta-assignment-progress"><div style="width:${Math.min(100,progress)}%"></div></div><div class="ta-assignment-bottom"><span class="ta-assignment-numbers">${submitted} submitted · ${pending} pending · ${avg}% avg</span><button class="btn ${selected?'good':'primary'} small" onclick="analyticsOpenAssignment('${safe(active)}','${safe(a.id)}')">${selected?'Viewing':'View marks'}</button></div></article>`
    }).join(''):`<div class="assignment-empty-slim"><h3>No assignments yet</h3><p>Publish the first assignment for this class to begin tracking progress.</p><button class="btn primary small" style="margin-top:10px" onclick="analyticsAssignToClass('${safe(active)}')">Assign now</button></div>`;

    let detail=`<div class="ta-detail-empty"><div><div class="empty-logo"><svg class="icon"><use href="#i-chart"></use></svg></div><h4>Select an assignment</h4><p>Choose an assignment from the left to view student marks, submissions and pending work.</p></div></div>`;
    if(activeAssignment){
      const subs=teacherSubmittedAssignmentsFor(active,activeAssignment.id),subMap=analyticsLatestSubmissionMap(subs);
      const latest=roster.map(st=>analyticsSubmissionForStudent(st,subMap)).filter(Boolean),submitted=latest.length,pending=Math.max(0,roster.length-submitted),correct=latest.reduce((n,r)=>n+(Number(r.score)||0),0),total=latest.reduce((n,r)=>n+(Number(r.total)||0),0),wrong=Math.max(0,total-correct),avg=avgSubmissionPct(latest);
      const rows=roster.length?roster.map(st=>{
        const sub=analyticsSubmissionForStudent(st,subMap),name=st.fullName||st.username||st.studentName||'Student',code=st.studentCode||st.studentKey||'No code',mail=st.email||st.studentEmail||'No email';
        const score=sub?Number(sub.score)||0:0,totalQ=sub?Number(sub.total)||0:(Number(activeAssignment.count)||0),wrongQ=sub?Math.max(0,totalQ-score):0,pct=sub?Math.round(Number(sub.pct)||0):0,time=sub?new Date(sub.submittedAt||sub.at||Date.now()).toLocaleString():'Not submitted';
        return `<div class="ta-student-row"><div class="ta-student-id"><b>${safe(name)}</b><small>${safe(code)} · ${safe(mail)}</small></div><div class="ta-cell"><span>Status</span><b><span class="ta-status ${sub?'done':''}">${sub?'Submitted':'Pending'}</span></b></div><div class="ta-cell"><span>Marks</span><b>${sub?`${safe(score)}/${safe(totalQ)}`:'—'}</b></div><div class="ta-cell"><span>Correct</span><b>${sub?safe(score):'—'}</b></div><div class="ta-cell"><span>Wrong</span><b>${sub?safe(wrongQ):'—'}</b></div><div class="ta-cell"><span>Score</span><b>${sub?`${safe(pct)}%`:'—'}</b></div><div class="ta-cell"><span>Submitted</span><b title="${safe(time)}">${sub?safe(time):'—'}</b></div></div>`
      }).join(''):`<div class="assignment-empty-slim"><h3>No students assigned</h3><p>Add or approve students in this class to track their marks here.</p></div>`;
      detail=`<div class="ta-detail-top"><div><span class="badge brand">${safe(assignmentTypeLabel(activeAssignment))}</span><h3>${safe(activeAssignment.title||'Untitled quiz')}</h3><p>${safe(activeAssignment.subject||activeMeta.subject||'General')} · Due ${safe(activeAssignment.due||'No due date')}</p></div><div class="ta-detail-actions"><button class="btn ghost small" onclick="previewAssignment(${Number(activeAssignment.id)||0})">Preview</button><button class="btn good small" onclick="analyticsAssignToClass('${safe(active)}')">Assign more</button></div></div><div class="ta-detail-kpis"><div><span>Assigned</span><b>${roster.length}</b></div><div><span>Submitted</span><b>${submitted}</b></div><div><span>Pending</span><b>${pending}</b></div><div><span>Correct</span><b>${correct}</b></div><div><span>Wrong</span><b>${wrong}</b></div><div><span>Average</span><b>${avg}%</b></div></div><div class="ta-scroll"><div class="ta-student-list">${rows}</div></div>`;
    }

    activeWorkspace=`<section class="ta-section"><div class="ta-active-head"><div><span class="badge brand">Selected class · ${safe(active)}</span><h2>${safe(activeMeta.className||'Academic Class')}</h2><p>${safe(activeMeta.subject||'General')} · Class key ${safe(activeMeta.classKey||'-')}</p></div><div class="ta-active-actions"><button class="btn primary small" onclick="analyticsAssignToClass('${safe(active)}')">Create assessment</button><button class="btn ghost small" onclick="analyticsOpenAssignmentWorkspace('${safe(active)}')">Manage assessments</button></div></div><div class="ta-class-summary"><div><span>Students</span><b>${roster.length}</b></div><div><span>Assessments</span><b>${activeAssignments.length}</b></div><div><span>Submissions</span><b>${classSubs.length}</b></div><div><span>Class average</span><b>${classAvg}%</b></div></div><div class="ta-workspace"><div class="ta-pane"><div class="ta-pane-head"><div><h4>Class assessments</h4><p>Select one assessment to inspect its progress.</p></div><span class="badge">${activeAssignments.length}</span></div><div class="ta-scroll"><div class="ta-assignment-list">${assignmentItems}</div></div></div><div class="ta-pane"><div class="ta-pane-head"><div><h4>Student marks</h4><p>Only students attached to the selected class and assignment.</p></div>${activeAssignment?`<span class="badge good">Live view</span>`:''}</div>${detail}</div></div></section>`;
  }

  out.innerHTML=`<div class="ta-dashboard"><section class="ta-hero"><div><span class="hero-kicker">Teacher intelligence workspace</span><h2>Class analytics</h2><p>Choose a class, open an assessment, and review every student’s submission, marks, correct answers, wrong answers and pending status without mixing classes.</p></div><div class="ta-hero-actions"><button class="btn ghost" onclick="showPanel('teacherStudentsPanel')">Manage classes</button>${active?`<button class="btn primary" onclick="analyticsAssignToClass('${safe(active)}')">New assessment</button>`:''}</div></section><div class="ta-kpis"><div class="ta-kpi"><span>Total classes</span><b>${classes.length}</b><small>Separate academic rooms</small></div><div class="ta-kpi"><span>Assessments</span><b>${allAssignments.length}</b><small>Published teacher work</small></div><div class="ta-kpi"><span>Students</span><b>${studentsTotal}</b><small>Joined and approved</small></div><div class="ta-kpi"><span>Overall average</span><b>${overallAvg}%</b><small>Across recorded submissions</small></div></div><section class="ta-section"><div class="ta-section-head"><div><h3>Choose a class</h3><p>Each class keeps its own students, assessments and marks.</p></div><span class="badge ta-section-count">${classes.length} class${classes.length===1?'':'es'}</span></div><div class="ta-class-grid">${classCards}</div></section>${activeWorkspace}</div>`;
}


/* TEACHER QUIZ ASSIGNMENT SOURCE UPDATE: Create Quiz, Direct MCQs, MCQ PDF, and Study PDF. */
function assignmentTypeLabel(a={}){
  const t=String(a.assignmentType||a.sourceKind||'create').toLowerCase();
  if(t==='direct')return 'Direct MCQs';
  if(t==='mcq_pdf')return 'MCQ PDF';
  if(t==='study_pdf')return 'PDF Generated Quiz';
  if(t==='generated')return 'Created quiz';
  return 'Created quiz'
}
function assignmentIsDirectQuiz(a={}){return Array.isArray(a.quiz)&&a.quiz.length>0}
function setTeacherAssignmentMode(mode='create'){
  mode=String(mode||'create');
  ['create','direct','mcq_pdf','study_pdf'].forEach(m=>{
    const btn=$('#taMode'+(m==='mcq_pdf'?'McqPdf':m==='study_pdf'?'StudyPdf':m[0].toUpperCase()+m.slice(1)));
    const pane=$('#taPane'+(m==='mcq_pdf'?'McqPdf':m==='study_pdf'?'StudyPdf':m[0].toUpperCase()+m.slice(1)));
    if(btn)btn.classList.toggle('active',m===mode);
    if(pane)pane.classList.toggle('active',m===mode);
  });
  state.teacherAssignmentMode=mode;
  const badge=$('#taModeBadge'),txt=$('#taPublishText');
  const labels={create:['CREATE QUIZ','Create quiz & assign'],direct:['DIRECT MCQS','Assign direct MCQs'],mcq_pdf:['MCQ PDF','Extract & assign MCQs'],study_pdf:['PDF TO MCQS','Generate & assign MCQs']};
  if(badge)badge.textContent=labels[mode]?.[0]||'CREATE QUIZ';
  if(txt)txt.textContent=labels[mode]?.[1]||'Assign';
  renderTeacherAssignPreview();
}
function teacherAssignmentMode(){return state.teacherAssignmentMode||'create'}
function teacherPdfName(inputId,labelId){const f=$('#'+inputId)?.files?.[0],el=$('#'+labelId);if(el)el.textContent=f?`${f.name} · ${(f.size/1024/1024).toFixed(2)} MB`:'No file selected'}
function renderTeacherAssignPreview(){
  const box=$('#teacherPreviewBox');if(!box)return;
  const mode=teacherAssignmentMode(),title=$('#taTitle')?.value?.trim()||'Untitled quiz',count=Math.max(1,Math.min(250,parseInt($('#taCount')?.value||10,10)||10)),cls=teacherClassMeta($('#taClassSelect')?.value||activeTeacherClassCode());
  const lines={create:['AI will create a ready quiz from teacher notes.','Student opens the quiz directly after assignment.'],direct:['Ready MCQs will be saved exactly as a quiz.','Student starts without generating anything.'],mcq_pdf:['Text MCQs will be extracted from the PDF.','Only extracted MCQs become the quiz.'],study_pdf:['Upload any readable PDF and AI will generate MCQs automatically.','The same generated quiz is assigned to every selected student.']};
  box.innerHTML=`<div class="timeline-item"><b>${safe(title)}</b><div class="hint">${safe(cls.className||'Selected class')} · ${safe(count)} question target</div><div class="teacher-preview-pill"><span class="badge brand">${safe(assignmentTypeLabel({assignmentType:mode==='create'?'generated':mode}))}</span><span class="badge">${safe(cls.code||'Class')}</span></div></div>`+(lines[mode]||lines.create).map(x=>`<div class="timeline-item"><b>${safe(x)}</b></div>`).join('')
}
function extractReadablePdfText(raw=''){
  raw=String(raw||'');
  const strings=[...raw.matchAll(/\(([^()]{3,500})\)/g)].map(m=>m[1].replace(/\\n/g,' ').replace(/\\r/g,' ').replace(/\\t/g,' ').replace(/\\\(/g,'(').replace(/\\\)/g,')'));
  const plain=raw.replace(/[^\x09\x0A\x0D\x20-\x7E]+/g,' ').replace(/\s+/g,' ');
  const combined=(strings.join('\n')+'\n'+plain).replace(/\s{2,}/g,' ').trim();
  return combined.slice(0,70000)
}
async function teacherFileText(inputId){const f=$('#'+inputId)?.files?.[0];if(!f)return '';const raw=await f.text();return extractReadablePdfText(raw)}
function mcqCleanLine(x){return String(x||'').replace(/[\u2022\u25CF\u25CB]/g,'').trim()}
function parseTeacherMCQs(input='',limit=250){
  const text=String(input||'').replace(/\r/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(!text)return [];
  const lines=text.split('\n').map(mcqCleanLine).filter(Boolean);
  const blocks=[];let cur=[];
  const qStart=/^(q\s*)?\d{1,3}\s*[\).:\-]\s+|^question\s+\d{1,3}\s*[\).:\-]\s+/i;
  lines.forEach(line=>{if(qStart.test(line)&&cur.length){blocks.push(cur);cur=[line]}else cur.push(line)});if(cur.length)blocks.push(cur);
  const optionRe=/^(?:[\*✓✔]\s*)?(?:\(?([A-Da-d])\)?[\).:\-]\s+)(.+)$/;
  const ansRe=/^(?:answer|correct|correct answer|ans)\s*[:\-]\s*(.+)$/i;
  const quiz=[];
  blocks.forEach((block,bi)=>{
    let qLines=[],opts=[],ansRaw='';
    block.forEach(line=>{
      const ans=line.match(ansRe);if(ans){ansRaw=ans[1].trim();return}
      const op=line.match(optionRe);
      if(op){const marked=/^[\*✓✔]/.test(line)||/\b(correct|answer)\b/i.test(line);opts.push({letter:op[1].toUpperCase(),text:op[2].replace(/\b\(?correct\)?\b/ig,'').trim(),marked});return}
      if(!opts.length)qLines.push(line);else if(opts.length){opts[opts.length-1].text=(opts[opts.length-1].text+' '+line).trim()}
    });
    if(opts.length>=2){
      let q=qLines.join(' ').replace(qStart,'').trim();
      if(!q)q='Question '+(quiz.length+1);
      let correct='';
      if(ansRaw){const letter=(ansRaw.match(/[A-Da-d]/)||[])[0];if(letter){const found=opts.find(o=>o.letter===letter.toUpperCase());if(found)correct=found.text}if(!correct){const low=ansRaw.toLowerCase();const found=opts.find(o=>o.text.toLowerCase().includes(low)||low.includes(o.text.toLowerCase()));if(found)correct=found.text}}
      if(!correct){const marked=opts.find(o=>o.marked);correct=marked?marked.text:opts[0].text}
      quiz.push(normalizeQuestion({id:'direct_'+Date.now()+'_'+bi,question:q,options:opts.map(o=>o.text).slice(0,6),correct,difficulty:'medium'},quiz.length))
    }
  });
  return quiz.slice(0,Math.max(1,Math.min(250,parseInt(limit||250,10))))
}
function localQuizFromStudyText(text='',count=10){
  const max=Math.max(1,Math.min(250,parseInt(count||10,10)));const parts=String(text||'').split(/[.!?\n]+/).map(x=>x.trim()).filter(x=>x.length>30).slice(0,max);
  return parts.map((x,i)=>normalizeQuestion({id:'teacher_local_'+Date.now()+'_'+i,question:'Which statement best matches this note: '+x.slice(0,110)+'?',options:['The statement is supported by the study material.','The statement is not related to the source.','The statement is only a heading.','The statement is a random example.'],correct:'The statement is supported by the study material.',difficulty:i%3===0?'easy':i%3===1?'medium':'hard'},i))
}
async function teacherGenerateQuizFromText(text,count,title){
  try{const d=await request('/api/v1/generate-quiz',{method:'POST',body:JSON.stringify({user_id:SESSION.user_id,text_content:text,count,quiz_title:title})});const q=(d.quiz||[]).map(normalizeQuestion);if(q.length)return q}catch(e){console.warn('Teacher generate fallback',e)}
  return localQuizFromStudyText(text,count)
}
function teacherAssignmentBase(cls,assignmentType,content,quiz=[],fileName=''){
  const d=profileDetails(),meta=teacherClassMeta(cls.code),title=$('#taTitle')?.value?.trim()||'Untitled quiz',subject=$('#taSubject')?.value?.trim()||cls.subject||d.teacherSubject||'General',count=quiz.length||Math.max(1,Math.min(250,parseInt($('#taCount')?.value||10,10)||10));
  return {id:Date.now(),teacherId:SESSION.user_id,teacherCode:teacherCode(),teacherName:meta.teacherName||d.fullName||SESSION.username,classCode:cls.code,className:cls.className,teacherSubject:d.teacherSubject||meta.subject||'General',teacherInstitute:d.institute||'',teacherDepartment:d.department||'',title,subject,due:$('#taDue')?.value||'',instructions:$('#taInstructions')?.value?.trim()||'',count,content:content||'',quiz:Array.isArray(quiz)?quiz:[],assignmentType,sourceKind:assignmentType,fileName:fileName||'',needsGenerate:assignmentType==='study_pdf',timeLimitMinutes:Math.max(0,Math.min(300,parseInt($('#taTimeLimit')?.value||0,10)||0)),allowRetake:($('#taAllowRetake')?.value||'yes')==='yes',createdAt:new Date().toISOString()}
}
async function createAssignment(){
  const btn=$('#teacherAssignBtn');
  try{
    const arr=ensureTeacherClasses();const selected=String($('#taClassSelect')?.value||activeTeacherClassCode()).toUpperCase();const cls=arr.find(c=>c.code===selected)||arr[0];if(!cls)return toast('Create a class first','error');
    setBusy(btn,true);
    const mode=teacherAssignmentMode(),count=Math.max(1,Math.min(250,parseInt($('#taCount')?.value||10,10)||10));
    let content='',quiz=[],type='generated',fileName='';
    if(mode==='create'){
      content=$('#taContent')?.value?.trim()||'';if(content.length<50)return toast('Paste at least 50 characters of notes','error');
      quiz=await teacherGenerateQuizFromText(content,count,$('#taTitle')?.value?.trim()||'Teacher quiz');type='generated';
    }else if(mode==='direct'){
      content=$('#taDirectMcqs')?.value?.trim()||'';quiz=parseTeacherMCQs(content,count);if(!quiz.length)return toast('No valid MCQs found. Use A-D options and Answer: A format.','error');type='direct';
    }else if(mode==='mcq_pdf'){
      const f=$('#taMcqPdf')?.files?.[0];fileName=f?.name||'';content=($('#taMcqPdfText')?.value?.trim()||'')||(await teacherFileText('taMcqPdf'));if(!content)return toast('Upload MCQ PDF or paste MCQ text','error');
      quiz=parseTeacherMCQs(content,count);if(!quiz.length)return toast('Could not extract MCQs. Paste copied MCQ text in backup box.','error');type='mcq_pdf';
    }else if(mode==='study_pdf'){
      const f=$('#taStudyPdf')?.files?.[0];fileName=f?.name||'';content=($('#taStudyText')?.value?.trim()||'')||(await teacherFileText('taStudyPdf'));if(content.length<20)return toast('Upload readable study PDF or paste study text','error');
      quiz=await teacherGenerateQuizFromText(content,count,$('#taTitle')?.value?.trim()||'PDF generated quiz');if(!quiz.length)return toast('Could not generate MCQs from this PDF','error');type='study_pdf';
    }
    publishTeacherDirectory(arr);const a=teacherAssignmentBase(cls,type,content,quiz,fileName);
    const mine=readJSON(assignmentsKey(),[]);mine.push(a);writeJSON(assignmentsKey(),mine);
    const classRows=readJSON(classAssignmentsKey(cls.code),[]);classRows.push(a);writeJSON(classAssignmentsKey(cls.code),classRows);
    state.activeTeacherAssignmentsClassCode=cls.code;writeJSON(profileKey(),{...profileDetails(),activeClassCode:cls.code});
    ['#taTitle','#taSubject','#taDue','#taInstructions','#taContent','#taDirectMcqs','#taMcqPdfText','#taStudyText'].forEach(id=>{const el=$(id);if(el)el.value=''});if($('#taTimeLimit'))$('#taTimeLimit').value='0';if($('#taAllowRetake'))$('#taAllowRetake').value='yes';
    ['#taMcqPdf','#taStudyPdf'].forEach(id=>{const el=$(id);if(el)el.value=''});teacherPdfName('taMcqPdf','taMcqPdfName');teacherPdfName('taStudyPdf','taStudyPdfName');
    renderTeacherAssignments();renderTeacherDashboard();toast(`${assignmentTypeLabel(a)} assigned to ${a.className}`,'success');showPanel('teacherAssignmentsPanel')
  }catch(e){toast(e.message||'Assignment failed','error')}finally{setBusy(btn,false)}
}
function directStartAssignedQuiz(a,code,meta){
  state.currentSessionAssignmentMeta=null;
  state.activeAssignmentMeta={origin:'teacher',assignmentId:a.id,assignmentTitle:a.title,title:a.title,classCode:code,className:a.className||meta.className,teacherName:a.teacherName||meta.teacherName,teacherCode:a.teacherCode||meta.teacherCode||'',subject:a.subject||meta.subject||'General',due:a.due||'',instructions:a.instructions||'',count:a.count||a.quiz?.length||getCount(),assignmentType:a.assignmentType||''};
  state.quiz=(a.quiz||[]).map((q,i)=>normalizeQuestion(q,i));state.answered={};state.submitted=false;state.lastResult=null;state.sessionId=null;state.filter='all';state.mcqPrompted=false;state.startedAt=Date.now();
  $('#scorePanel')?.classList.remove('show');if($('#quizTitle'))$('#quizTitle').value=a.title||'Assigned quiz';if($('#customCount'))$('#customCount').value=state.quiz.length;
  showPanel('generatePanel');startTimer();renderQuiz();focusQuizMode(true);toast('Assigned quiz opened directly','success')
}
function openStudyAssignment(a,code,meta){
  state.currentSessionAssignmentMeta=null;
  state.activeAssignmentMeta={origin:'teacher',assignmentId:a.id,assignmentTitle:a.title,title:a.title,classCode:code,className:a.className||meta.className,teacherName:a.teacherName||meta.teacherName,teacherCode:a.teacherCode||meta.teacherCode||'',subject:a.subject||meta.subject||'General',due:a.due||'',instructions:a.instructions||'',count:a.count||getCount(),assignmentType:a.assignmentType||''};
  state.quiz=[];state.answered={};state.submitted=false;state.lastResult=null;state.sessionId=null;focusQuizMode(false);showPanel('generatePanel');setSource('text');
  if($('#quizTitle'))$('#quizTitle').value=a.title||'Study assignment';if($('#textData'))$('#textData').value=a.content||a.studyText||'';if($('#customCount'))$('#customCount').value=a.count||getCount();updateTextStats();
  const out=$('#quizOut');if(out)out.innerHTML=`<div class="study-preview-box"><b>${safe(a.fileName||'Study material')}</b><br>${safe((a.content||'').slice(0,500))}${(a.content||'').length>500?'...':''}</div><div class="empty" style="min-height:180px"><div><h3>Study first, then generate MCQs</h3><p>This assignment is a study PDF/text source. Read the content on the left, then press Generate professional quiz when ready.</p></div></div>`;
  toast('Study assignment opened. Read and generate MCQs when ready.','success')
}
function startAssignment(id){
  const a=getStudentAssignments().find(x=>String(x.id)===String(id));if(!a)return;
  const code=a.joinedClassCode||a.classCode||'',meta=teacherClassMeta(code);
  if(assignmentIsDirectQuiz(a))return directStartAssignedQuiz(a,code,meta);
  return openStudyAssignment(a,code,meta)
}
function assignmentCardTypeMeta(a){const label=assignmentTypeLabel(a),direct=assignmentIsDirectQuiz(a);return {label,direct,action:direct?'Start quiz':'Quiz unavailable',hint:direct?'The same teacher-generated quiz opens directly for every student.':'This assignment has no generated questions.'}}
function renderTeacherAssignments(){
  const out=$('#teacherAssignmentsOut');if(!out)return;
  const classes=ensureTeacherClasses(),active=currentSelectedTeacherAssignmentClass(),activeMeta=teacherClassMeta(active),allRows=readJSON(assignmentsKey(),[]).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)),rows=allRows.filter(a=>String(a.classCode||'').toUpperCase()===active),students=readJSON(studentsKey(active),[]),subAll=teacherSubmittedAssignmentsFor(active),set=(id,v)=>{const el=$('#'+id);if(el)el.textContent=v};
  set('teacherAssignmentClassBadge',classes.length+' class'+(classes.length===1?'':'es'));set('teacherAssignmentListBadge',rows.length+' assessments');
  const classList=$('#teacherAssignmentClassList');
  if(classList)classList.innerHTML=classes.length?classes.map(c=>{const code=String(c.code).toUpperCase(),ass=readJSON(classAssignmentsKey(code),[]),subs=teacherSubmittedAssignmentsFor(code),std=readJSON(studentsKey(code),[]),pct=ass.length?Math.round((subs.length/Math.max(1,ass.length*Math.max(1,std.length||1)))*100):0;return `<div class="assignment-pro-class-card ${code===active?'active':''}"><div><span class="class-kicker">Teacher class</span><div class="class-title">${safe(c.className||'Academic Class')}</div><div class="class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span><span class="badge">Key: ${safe(c.classKey||'-')}</span></div></div><div class="assignment-mini-stats"><div><span>Students</span><b>${std.length}</b></div><div><span>Assessments</span><b>${ass.length}</b></div><div><span>Progress</span><b>${pct}%</b></div></div><div class="class-actions"><button class="btn primary small" onclick="selectTeacherAssignmentClass('${safe(code)}')">Open class</button><button class="btn ghost small" onclick="teacherAssignToClass('${safe(code)}')">Create</button></div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No class yet</h3><p>Create classes first from Classes.</p></div>`;
  const title=$('#teacherAssignmentWorkspaceTitle'),hint=$('#teacherAssignmentWorkspaceHint');if(title)title.textContent=(activeMeta.className||'Selected class')+' progress';if(hint)hint.textContent=`${students.length} student${students.length===1?'':'s'} · ${rows.length} assessment${rows.length===1?'':'s'} · ${subAll.length} submission${subAll.length===1?'':'s'}`;
  const prog=$('#teacherAssignmentProgressOut'),avg=avgSubmissionPct(subAll);if(prog)prog.innerHTML=`<div class="assignment-progress-summary"><div><span>Students</span><b>${students.length}</b></div><div><span>Assessments</span><b>${rows.length}</b></div><div><span>Submissions</span><b>${subAll.length}</b></div><div><span>Average</span><b>${avg}%</b></div></div>${rows.length?rows.map(a=>{const subs=teacherSubmittedAssignmentsFor(active,a.id),unique=uniqueSubmissionStudents(subs),den=Math.max(1,students.length||1),pct=Math.min(100,Math.round(unique/den*100));return `<div class="assignment-progress-row"><div><span>${safe(assignmentTypeLabel(a))} · ${safe(a.subject||activeMeta.subject||'General')}</span><h3>${safe(a.title)}</h3><p>${unique}/${students.length||0} students submitted · ${subs.length} attempt${subs.length===1?'':'s'} · Due ${safe(a.due||'No due date')}</p><div class="assignment-progress-bar"><div style="width:${pct}%"></div></div></div><div class="assignment-progress-pct">${pct}%</div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No assessments yet</h3><p>Press Create assessment to publish work for this selected class.</p></div>`}`;
  out.innerHTML=rows.length?rows.map(a=>{const meta=teacherClassMeta(a.classCode),subs=teacherSubmittedAssignmentsFor(a.classCode,a.id),unique=uniqueSubmissionStudents(subs),avg=avgSubmissionPct(subs),tm=assignmentCardTypeMeta(a);return `<div class="assignment-pro-card"><div><span class="assignment-class-title">${safe(meta.className)} · ${safe(a.classCode)}</span><h3>${safe(a.title)}</h3><p class="muted">${safe(a.subject||meta.subject||'General')} · ${safe(a.count||a.quiz?.length||0)} ${tm.direct?'MCQs':'study target'} · ${unique} submitted · avg ${avg}%</p><div class="assignment-pro-meta"><span class="badge brand assignment-type-pill">${safe(tm.label)}</span><span class="badge">Due: ${safe(a.due||'No due date')}</span><span class="badge">${a.timeLimitMinutes?safe(a.timeLimitMinutes)+' min':'No timer'}</span><span class="badge ${a.allowRetake===false?'warn':'good'}">${a.allowRetake===false?'One attempt':'Retake allowed'}</span><span class="badge good">${subs.length} attempt${subs.length===1?'':'s'}</span></div><div class="assignment-pro-note"><b>Instructions</b>${safe(a.instructions||tm.hint)}</div></div><div class="assignment-pro-actions"><button class="btn ghost small" onclick="previewAssignment(${a.id})">Preview</button><button class="btn danger small" onclick="deleteAssignment(${a.id})">Delete</button></div></div>`}).join(''):`<div class="assignment-empty-slim"><h3>No assessment in this class</h3><p>${safe(activeMeta.className||'This class')} has no published work yet.</p><button class="btn primary small" style="margin-top:12px" onclick="teacherAssignToSelectedClass()">Create assessment</button></div>`
}
function renderStudentAssignments(){
  const out=$('#studentAssignmentsOut');if(!out)return;
  const d=profileDetails(),codes=studentJoinedCodes(),classes=studentClassRows(),joinedClasses=classes.filter(c=>c.status==='joined'),allRows=getStudentAssignments(),total=allRows.reduce((s,a)=>s+(parseInt(a.count,10)||0),0),stdCode=studentAccessCode(),approvedOnly=classes.filter(c=>c.status==='approved').length,set=(id,v)=>{const el=$('#'+id);if(el)el.textContent=v};
  set('asClassCode',codes.length?codes.length+' joined':'0 joined');set('asTotal',allRows.length);set('asQuestions',total);set('asStudentCode',stdCode);set('asStudentAccessCode',stdCode);set('asJoinedCount',codes.length+' joined'+(approvedOnly?' · '+approvedOnly+' approved':''));set('saClassCount',codes.length?codes.length+' joined':'0');set('saAssignmentTotal',allRows.length);set('saQuestionTotal',total);
  const inp=$('#joinClassCode');if(inp)inp.placeholder='Teacher code or class code: TCH-AB12 / CLS-1234';
  let active=String(state.activeStudentClassCode||'').toUpperCase();if(active&&!classes.some(c=>String(c.code).toUpperCase()===active))active='';if(!active)active=joinedClasses[0]?.code||classes[0]?.code||'';state.activeStudentClassCode=active;
  const classBoard=$('#asClassList');if(classBoard)classBoard.innerHTML=classes.length?classes.map(c=>renderStudentAssignmentClassCard(c,active,false)).join(''):`<div class="assign-class-empty"><b>No class found yet.</b><br>Enter teacher code to view all classes, class code to view one class, or ask teacher to approve your student key.</div>`;
  const assClassList=$('#studentAssignmentsClassList');if(assClassList)assClassList.innerHTML=joinedClasses.length?joinedClasses.map(c=>renderStudentAssignmentClassCard(c,active,true)).join(''):`<div class="assignment-empty-slim"><h3>No joined classes</h3><p>Open Classes section, join your correct class, then assessments will appear here class-wise.</p><button class="btn primary small" style="margin-top:12px" onclick="showPanel('studentClassesPanel')">Join class</button></div>`;
  set('studentAssignmentClassBadge',joinedClasses.length+' joined');
  const activeMeta=classes.find(c=>String(c.code).toUpperCase()===active)||null,activeJoined=active&&codes.includes(active),rows=activeJoined?getStudentAssignments(active):[],submitted=activeJoined?studentAssignmentSubmissions(active):[];
  set('asListBadge',activeJoined?rows.length+' active':(activeMeta?'Join class':'0 active'));set('saActiveClass',activeMeta?(activeMeta.className||activeMeta.code||'Class'):'None');set('studentAssignmentSubmittedBadge',submitted.length+' submitted');
  const title=$('#studentAssignmentDetailTitle'),hint=$('#studentAssignmentDetailHint'),subTitle=$('#studentSubmittedTitle');if(title)title.textContent=activeMeta?`${activeMeta.className||'Class'} assessments`:'Class assessments';if(hint)hint.textContent=activeMeta?(activeJoined?'Active assessments from this selected class are shown below.':'This class is approved. Join it first to open assessments.'):'Select a joined class first.';if(subTitle)subTitle.textContent=activeMeta?`${activeMeta.className||'Class'} submitted work`:'Submitted assessments';
  const info=$('#asStudentBox');if(info){const p=[['Student',d.fullName||SESSION.username||'Student'],['Student key',stdCode],['Roll / ID',d.academicId||d.studentId||d.academicId||'Not added'],['Institute',d.institute||d.university||'Not added'],['Department',d.department||'Not added']];info.innerHTML=p.map(r=>`<div><span>${safe(r[0])}</span><b>${safe(r[1])}</b></div>`).join('')}
  if(!activeMeta){out.innerHTML=`<div class="assignment-empty-slim"><h3>No class selected</h3><p>Join a class first, then class assessments will appear here.</p></div>`}else if(!activeJoined){out.innerHTML=`<div class="assignment-empty-slim"><h3>${safe(activeMeta.className||'Approved class')}</h3><p>Join this approved class first, then assessments will appear here.</p><button class="btn primary small" style="margin-top:12px" onclick="joinApprovedStudentClass('${safe(active)}')">Join approved class</button></div>`}else if(!rows.length){out.innerHTML=`<div class="assignment-empty-slim"><h3>No active assessments</h3><p>${safe(activeMeta.teacherName||'Teacher')} has not assigned work to ${safe(activeMeta.className||'this class')} yet.</p></div>`}else{out.innerHTML=rows.map((a,i)=>{const due=a.due?new Date(a.due).toLocaleDateString():'No due date',ins=a.instructions||'No extra instructions from teacher.',code=a.joinedClassCode||a.classCode||'Class',meta=teacherClassMeta(code),className=a.className||meta.className,teacher=a.teacherName||meta.teacherName,done=studentAssignmentSubmissions(code,a.id).length,tm=assignmentCardTypeMeta(a);return `<div class="assignment-pro-card"><div><span>Assessment ${rows.length-i} · ${safe(className)}</span><h3>${safe(a.title)}</h3><p class="muted">${safe(a.subject||meta.subject||'General')} · ${tm.direct?`${safe(a.count||a.quiz?.length||0)} MCQs`:'Study material'} · Teacher: ${safe(teacher)}</p><div class="assignment-pro-meta"><span class="badge brand assignment-type-pill">${safe(tm.label)}</span><span class="badge">Due: ${safe(due)}</span><span class="badge">${a.timeLimitMinutes?safe(a.timeLimitMinutes)+' min':'No timer'}</span><span class="badge ${a.allowRetake===false?'warn':'good'}">${a.allowRetake===false?'One attempt':'Retake allowed'}</span>${done?`<span class="badge good">Submitted ${done}</span>`:'<span class="badge warn">Pending</span>'}</div><div class="assignment-pro-note"><b>Teacher instructions</b>${safe(ins||tm.hint)}</div></div><div class="assignment-pro-actions"><button class="btn primary small" onclick="startAssignment(${a.id})">${safe(tm.action)}</button><button class="btn ghost small" onclick="showPanel('historyPanel')">Results</button></div></div>`}).join('')}
  const subOut=$('#studentSubmittedAssignmentsOut');if(subOut)subOut.innerHTML=submitted.length?submitted.map(r=>`<div class="submitted-assignment-card"><div><span>${safe(r.subject||r.meta?.subject||'Submitted assessment')}</span><h3>${safe(r.assignmentTitle||r.title||r.meta?.assignmentTitle||'Assessment attempt')}</h3><p>${safe(new Date(r.submittedAt||r.at||Date.now()).toLocaleString())} · ${safe(r.score??0)}/${safe(r.total??0)} correct · ${safe(r.time||'00:00')}</p></div><div class="submitted-score-pill">${safe(r.pct??0)}%</div></div>`).join(''):`<div class="assignment-empty-slim"><h3>No submitted assessments</h3><p>After submitting a quiz from this class, the completed attempt will appear here.</p></div>`
}
function closeTeacherAssignmentPreview(){
  const panel=$('#teacherAssignmentsPanel');
  const box=$('#teacherInlineAssignmentPreview');
  panel?.classList.remove('inline-preview-open');
  if(box)box.innerHTML='';
  renderTeacherAssignments();
}
function previewAssignment(id){
  const a=readJSON(assignmentsKey(),[]).find(x=>String(x.id)===String(id));if(!a)return;
  showPanel('teacherAssignmentsPanel');
  const panel=$('#teacherAssignmentsPanel');
  const box=$('#teacherInlineAssignmentPreview');
  if(!panel||!box)return;
  panel.classList.add('inline-preview-open');
  const meta=teacherClassMeta(a.classCode);
  const className=a.className||meta.className||'Academic Class';
  const subject=a.subject||meta.subject||'General';
  const due=a.due?new Date(a.due).toLocaleDateString():'No due date';
  const quiz=Array.isArray(a.quiz)?a.quiz:[];
  const count=a.count||quiz.length||0;

  /* Preview-only question recovery: use the exact MCQ text originally assigned. */
  const invalidQuestionText=value=>{
    const s=String(value??'').trim();
    if(!s)return true;
    if(/^[\s_\-–—.]{2,}$/.test(s))return true;
    if(/^question\s*\d*$/i.test(s))return true;
    if(/^(fill[_ -]?blank|multiple[_ -]?choice|single[_ -]?choice|mcq|quiz|question[_ -]?type|true[_ -]?false)$/i.test(s))return true;
    return false;
  };
  let sourceQuiz=[];
  try{
    if(String(a.content||'').trim())sourceQuiz=parseTeacherMCQs(a.content,Math.max(quiz.length,parseInt(a.count||0,10)||0,1));
  }catch(_){sourceQuiz=[]}
  const findQuestionInObject=(obj,depth=0,seen=new Set())=>{
    if(!obj||typeof obj!=='object'||depth>4||seen.has(obj))return '';
    seen.add(obj);
    const preferred=[];
    for(const [key,value] of Object.entries(obj)){
      if(Array.isArray(value))continue;
      const k=String(key||'');
      if(/(type|format|kind|mode|difficulty|answer|correct|option|choice|id|label|value)/i.test(k))continue;
      if(typeof value==='string'&&/(question|prompt|stem|statement|body|query|text|content)/i.test(k)&&!invalidQuestionText(value))preferred.push(value.trim());
    }
    if(preferred.length)return preferred.sort((x,y)=>y.length-x.length)[0];
    for(const [key,value] of Object.entries(obj)){
      if(Array.isArray(value)||!value||typeof value!=='object')continue;
      if(/(options|choices|answers)/i.test(String(key)))continue;
      const found=findQuestionInObject(value,depth+1,seen);if(found)return found;
    }
    return '';
  };
  const actualQuestion=(q,i)=>{
    const parsed=sourceQuiz[i]?.question;
    if(!invalidQuestionText(parsed))return String(parsed).trim();
    const direct=[q?.question,q?.question_body,q?.questionText,q?.question_text,q?.question_statement,q?.statement,q?.prompt,q?.stem,q?.body,q?.query,q?.q,q?.text,q?.content,q?.data?.question,q?.data?.question_text,q?.data?.prompt,q?.mcq?.question,q?.mcq?.prompt];
    for(const value of direct){if(!invalidQuestionText(value))return String(value).trim()}
    return findQuestionInObject(q);
  };

  let content='';
  if(assignmentIsDirectQuiz(a)&&quiz.length){
    content=quiz.map((q,i)=>{
      const questionText=actualQuestion(q,i);
      const rawOptions=Array.isArray(q?.options)?q.options:Array.isArray(q?.choices)?q.choices:Array.isArray(q?.answers)?q.answers:[];
      const opts=rawOptions.map(o=>{if(o&&typeof o==='object')return String(o.text??o.label??o.value??o.option??'').trim();return String(o??'').trim()}).filter(Boolean);
      const correct=String(q?.correct??q?.answer??q?.correctAnswer??q?.correct_answer??'').trim();
      const options=opts.map((val,j)=>{
        const letter=String.fromCharCode(65+j);
        const normalizedCorrect=correct.replace(/^[A-F][\).:\-]?\s*/i,'').trim();
        const isCorrect=val.toLowerCase()===correct.toLowerCase()||val.toLowerCase()===normalizedCorrect.toLowerCase()||letter===correct.toUpperCase();
        return `<div class="assignment-view-option ${isCorrect?'correct':''}"><b>${letter}.</b><span>${safe(val)}</span></div>`
      }).join('');
      return `<div class="assignment-view-question"><div class="assignment-view-question-label">Question ${i+1}</div><h3>${safe(questionText||'Question text was not stored with this assignment.')}</h3><div class="assignment-view-options">${options||`<div class="assignment-view-option correct"><b>Answer</b><span>${safe(correct||'Not provided')}</span></div>`}</div></div>`
    }).join('')
  }else{
    content=`<div class="assignment-view-study">${safe(a.content||'No study content is stored in this assignment.')}</div>`
  }
  box.innerHTML=`<div class="teacher-inline-preview-card">
    <div class="assignment-view-head">
      <div><span class="badge brand">${safe(assignmentTypeLabel(a))}</span><h1>${safe(a.title||'Untitled assessment')}</h1><p>${safe(className)} · ${safe(a.classCode||meta.code||'Class')}</p></div>
      <button class="btn ghost teacher-inline-preview-close" onclick="closeTeacherAssignmentPreview()">Close preview</button>
    </div>
    <div class="assignment-view-meta">
      <div><span>Subject</span><b>${safe(subject)}</b></div>
      <div><span>Due date</span><b>${safe(due)}</b></div>
      <div><span>Questions / target</span><b>${safe(count)}</b></div>
      <div><span>Class</span><b>${safe(className)}</b></div>
    </div>
    <div class="assignment-view-note"><span>Teacher instructions</span><p>${safe(a.instructions||'No extra instructions')}</p></div>
    <div class="assignment-view-content">${content}</div>
  </div>`;
  requestAnimationFrame(()=>box.scrollIntoView({behavior:'smooth',block:'start'}));
}


async function openAIDraftReview(d){
  let modal=$('#aiReviewModal');
  if(!modal){
    modal=document.createElement('div');modal.id='aiReviewModal';modal.style.cssText='position:fixed;inset:0;background:rgba(2,6,23,.88);z-index:9999;overflow:auto;padding:24px;display:none';
    modal.innerHTML=`<div style="max-width:1050px;margin:auto;background:#0b1324;border:1px solid rgba(148,163,184,.25);border-radius:24px;padding:22px"><div style="display:flex;justify-content:space-between;gap:15px;align-items:flex-start"><div><h2 style="margin:0">AI Question Review</h2><p id="aiReviewMeta" style="color:#94a3b8"></p></div><button class="btn" onclick="closeAIDraftReview()">Close</button></div><div id="aiReviewWarnings"></div><div id="aiReviewList" style="display:grid;gap:14px;margin:18px 0"></div><div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" onclick="approveAllAIDraft()">Approve valid questions</button><button class="btn primary" onclick="finalizeAIDraft()">Finalize approved quiz</button></div></div>`;document.body.appendChild(modal);
  }
  state.aiDraft=d;modal.style.display='block';renderAIDraftReview();
}
function closeAIDraftReview(){const m=$('#aiReviewModal');if(m)m.style.display='none'}
function renderAIDraftReview(){const d=state.aiDraft||{},qs=d.questions||[];$('#aiReviewMeta').textContent=`${d.title||'Draft'} · ${qs.length} reviewable questions · ${qs.filter(q=>q.status==='approved').length} approved`;$('#aiReviewWarnings').innerHTML=(d.warnings||[]).map(x=>`<div style="padding:10px 12px;border:1px solid rgba(245,158,11,.35);border-radius:12px;margin-top:8px;color:#fbbf24">${safe(x)}</div>`).join('');$('#aiReviewList').innerHTML=qs.map((q,i)=>`<div style="border:1px solid ${q.status==='approved'?'rgba(72,229,155,.45)':'rgba(148,163,184,.24)'};border-radius:18px;padding:16px"><div style="display:flex;justify-content:space-between;gap:10px"><b>Question ${i+1}</b><span>${safe(q.status)} · quality ${Math.round((q.quality_score||0)*100)}%</span></div><textarea id="draftQ_${q.id}" style="width:100%;margin-top:10px;min-height:72px">${safe(q.question)}</textarea>${q.options.map((op,j)=>`<div style="display:grid;grid-template-columns:42px 1fr;gap:8px;margin-top:8px"><input type="radio" name="draftCorrect_${q.id}" value="${j}" ${j===q.correct_index?'checked':''}><input id="draftO_${q.id}_${j}" value="${safe(op)}"></div>`).join('')}<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn" onclick="saveAIDraftQuestion(${q.id},'approved')">Save & approve</button><button class="btn" onclick="saveAIDraftQuestion(${q.id},'pending')">Save draft</button><button class="btn danger" onclick="removeAIDraftQuestion(${q.id})">Remove</button></div>${(q.validation||[]).map(v=>`<small style="display:block;color:#fbbf24;margin-top:6px">${safe(v)}</small>`).join('')}</div>`).join('')}
async function saveAIDraftQuestion(id,status){try{const q=(state.aiDraft.questions||[]).find(x=>x.id===id);const options=q.options.map((_,j)=>$(`#draftO_${id}_${j}`).value.trim());const picked=document.querySelector(`input[name="draftCorrect_${id}"]:checked`);state.aiDraft=await request(`/api/v1/ai/drafts/${state.aiDraft.id}/questions/${id}`,{method:'PATCH',body:JSON.stringify({question:$(`#draftQ_${id}`).value.trim(),options,correct_index:Number(picked?.value||0),status})});renderAIDraftReview();toast('Question saved','success')}catch(e){toast(e.message,'error')}}
async function removeAIDraftQuestion(id){try{await request(`/api/v1/ai/drafts/${state.aiDraft.id}/questions/${id}`,{method:'DELETE'});state.aiDraft=await request(`/api/v1/ai/drafts/${state.aiDraft.id}`);renderAIDraftReview()}catch(e){toast(e.message,'error')}}
async function approveAllAIDraft(){for(const q of (state.aiDraft.questions||[])){if(q.status!=='approved'&&!(q.validation||[]).length)await saveAIDraftQuestion(q.id,'approved')}renderAIDraftReview()}
async function finalizeAIDraft(){try{const d=await request(`/api/v1/ai/drafts/${state.aiDraft.id}/finalize`,{method:'POST',body:JSON.stringify({title:$('#quizTitle').value.trim()||state.aiDraft.title,approved_only:true})});state.quiz=(d.quiz||[]).map(normalizeQuestion);state.sessionId=d.session_id;state.answered={};state.submitted=false;state.startedAt=Date.now();closeAIDraftReview();startTimer();renderQuiz();focusQuizMode(true);toast('Approved quiz finalized','success')}catch(e){toast(e.message,'error')}}
function boot(){applyTheme();const u=localStorage.getItem('aqg_remember_username');if(u){$('#l_user').value=u;$('#rememberMe').checked=true}$('#textData').addEventListener('input',updateTextStats);$('#customCount').addEventListener('input',updateTextStats);$('#pdfInput').addEventListener('change',e=>handlePdf(e.target.files[0]));if(!SESSION)restoreSession();if(SESSION){showApp()}else{showAuth()}updateTextStats()}
document.addEventListener('DOMContentLoaded',boot);

/* =============================================================
   BACKEND PORTAL SYNC HOTFIX
   Keeps the existing UI, but makes classes and assignments use
   the authenticated backend instead of browser-only localStorage.
   ============================================================= */
const AQG_SYNC={classes:[],assignments:[],discovered:[],busy:false,ready:false};
function aqgClassByCode(code){return AQG_SYNC.classes.find(c=>String(c.code||c.classCode).toUpperCase()===String(code||'').toUpperCase())||null}
function aqgCacheClasses(payload){
  const rows=Array.isArray(payload?.classes)?payload.classes:[];
  AQG_SYNC.classes=rows;
  if(getRole()==='teacher'){
    writeJSON(teacherClassesKey(),rows);
    rows.forEach(c=>writeJSON(studentsKey(c.code||c.classCode),Array.isArray(c.members)?c.members:[]));
    if(rows.length&&!rows.some(c=>String(c.code||c.classCode).toUpperCase()===String(profileDetails().activeClassCode||'').toUpperCase()))writeJSON(profileKey(),{...profileDetails(),activeClassCode:rows[0].code||rows[0].classCode});
  }else{
    const codes=rows.map(c=>String(c.code||c.classCode).toUpperCase());
    saveStudentJoinedCodes(codes);
    const dir=readJSON(classDirectoryKey(),{});rows.forEach(c=>{dir[String(c.code||c.classCode).toUpperCase()]=c});writeJSON(classDirectoryKey(),dir);
  }
  return rows;
}
function aqgCacheAssignments(payload){
  const rows=Array.isArray(payload?.assignments)?payload.assignments:[];
  AQG_SYNC.assignments=rows;
  if(getRole()==='teacher')writeJSON(assignmentsKey(),rows);
  const grouped={};rows.forEach(a=>{const code=String(a.classCode||'').toUpperCase();if(!grouped[code])grouped[code]=[];grouped[code].push(a)});
  Object.entries(grouped).forEach(([code,list])=>writeJSON(classAssignmentsKey(code),list));
  return rows;
}
async function syncAcademicPortal(silent=true){
  if(!SESSION||AQG_SYNC.busy)return;
  AQG_SYNC.busy=true;
  try{
    const [classes,assignments]=await Promise.all([request('/api/v1/classes/mine'),request('/api/v1/assignments/mine')]);
    aqgCacheClasses(classes);aqgCacheAssignments(assignments);AQG_SYNC.ready=true;
    paintUser();
    if(getRole()==='teacher'){renderTeacherClassSelect();renderTeacherDashboard();renderTeacherStudents();renderTeacherAssignments()}
    else{renderStudentAssignments();renderStudentDashboard()}
  }catch(e){if(!silent)toast(e.message,'error')}finally{AQG_SYNC.busy=false}
}

const _aqgShowApp=showApp;
showApp=function(){_aqgShowApp();setTimeout(()=>syncAcademicPortal(true),60)};
const _aqgRenderPanel=renderPanel;
renderPanel=function(id){_aqgRenderPanel(id);if(['teacherDashboard','teacherStudentsPanel','teacherAssignmentsPanel','teacherQuizPanel','studentDashboard','studentClassesPanel','studentAssignmentsPanel'].includes(id))syncAcademicPortal(true)};

createTeacherClass=async function(){
  const btn=$('#teacherClassCreateBtn')||$('#tcName')?.closest('.teacher-class-form')?.querySelector('button');
  const name=($('#tcName')?.value||'').trim(),subject=($('#tcSubject')?.value||'General').trim(),section=($('#tcSection')?.value||'').trim(),class_key=($('#tcKey')?.value||'').trim();
  if(!name)return toast('Enter class name','error');
  try{setBusy(btn,true);await request('/api/v1/classes',{method:'POST',body:JSON.stringify({name,subject,section,class_key:class_key||null})});['#tcName','#tcSubject','#tcSection','#tcKey'].forEach(id=>{const el=$(id);if(el)el.value=''});await syncAcademicPortal(false);toast('Class created successfully','success')}catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}
};
deleteTeacherClass=async function(code){
  const c=aqgClassByCode(code)||ensureTeacherClasses().find(x=>String(x.code).toUpperCase()===String(code).toUpperCase());if(!c)return;
  if(!confirm('Delete this class? Students will lose access to its active assignments.'))return;
  try{await request(`/api/v1/classes/${c.id}`,{method:'DELETE'});await syncAcademicPortal(false);toast('Class removed','success')}catch(e){toast(e.message,'error')}
};
addAllowedStudents=async function(code){
  const c=aqgClassByCode(code);const inp=$('#allow_'+String(code).toUpperCase()),raw=(inp?.value||'').trim();if(!c||!raw)return toast('Add a student code or email','error');
  try{for(const value of raw.split(/[\s,;]+/).filter(Boolean))await request(`/api/v1/classes/${c.id}/approvals`,{method:'POST',body:JSON.stringify({value})});if(inp)inp.value='';await syncAcademicPortal(false);toast('Student approval saved','success')}catch(e){toast(e.message,'error')}
};
removeAllowedStudent=async function(code,value){const c=aqgClassByCode(code);if(!c)return;try{await request(`/api/v1/classes/${c.id}/approvals/${encodeURIComponent(value)}`,{method:'DELETE'});await syncAcademicPortal(false)}catch(e){toast(e.message,'error')}};

findTeacherClasses=async function(){
  const input=$('#joinClassCode'),code=String(input?.value||'').trim().toUpperCase();if(!code)return toast('Enter teacher code or class code','error');
  try{const data=await request('/api/v1/classes/discover/'+encodeURIComponent(code));AQG_SYNC.discovered=data.classes||[];const dir=readJSON(classDirectoryKey(),{});AQG_SYNC.discovered.forEach(c=>dir[String(c.code||c.classCode).toUpperCase()]=c);writeJSON(classDirectoryKey(),dir);state.joinClassFilterCode=code.startsWith('CLS-')?code:'';renderStudentAssignments();toast(AQG_SYNC.discovered.length?`${AQG_SYNC.discovered.length} class${AQG_SYNC.discovered.length===1?'':'es'} found`:'No class found',AQG_SYNC.discovered.length?'success':'error')}catch(e){toast(e.message,'error')}
};
joinClass=findTeacherClasses;
joinTeacherClass=async function(_teacherInvite,classCode){
  const code=String(classCode||'').toUpperCase(),key=String($('#joinKey_'+code)?.value||'').trim();
  try{await request('/api/v1/classes/join',{method:'POST',body:JSON.stringify({code,class_key:key||null})});await syncAcademicPortal(false);state.activeStudentClassCode=code;renderStudentAssignments();paintUser();toast('Class joined successfully','success')}catch(e){toast(e.message,'error')}
};
joinApprovedStudentClass=async function(code){return joinTeacherClass('',code)};

async function teacherGenerateQuizFromPdf(file,count,title){
  if(!file)throw new Error('Upload a PDF first');
  const fd=new FormData();
  fd.append('user_id',SESSION.user_id);
  fd.append('count',Math.max(1,Math.min(100,Number(count)||10)));
  fd.append('quiz_title',title||'PDF generated quiz');
  fd.append('file',file);
  const d=await request('/api/v1/generate-quiz-pdf',{method:'POST',body:fd});
  const quiz=(d.quiz||[]).map(normalizeQuestion);
  if(!quiz.length)throw new Error('No reliable MCQs could be generated from this PDF');
  return quiz;
}

async function aqgBuildAssignmentFromForm(){
  const classes=AQG_SYNC.classes.length?AQG_SYNC.classes:ensureTeacherClasses();const selected=String($('#taClassSelect')?.value||activeTeacherClassCode()).toUpperCase();const cls=classes.find(c=>String(c.code||c.classCode).toUpperCase()===selected)||classes[0];if(!cls)throw new Error('Create a class first');
  const mode=teacherAssignmentMode(),count=Math.max(1,Math.min(100,parseInt($('#taCount')?.value||10,10)||10));let content='',quiz=[],source_type='generated';
  if(mode==='create'){content=$('#taContent')?.value?.trim()||'';if(content.length<50)throw new Error('Paste at least 50 characters of notes');quiz=await teacherGenerateQuizFromText(content,count,$('#taTitle')?.value?.trim()||'Teacher quiz')}
  else if(mode==='direct'){content=$('#taDirectMcqs')?.value?.trim()||'';quiz=parseTeacherMCQs(content,count);if(!quiz.length)throw new Error('No valid MCQs found. Use A-D options and Answer: A format.');source_type='direct'}
  else if(mode==='mcq_pdf'){content=($('#taMcqPdfText')?.value?.trim()||'')||(await teacherFileText('taMcqPdf'));quiz=parseTeacherMCQs(content,count);if(!quiz.length)throw new Error('Could not extract valid MCQs from this PDF/text');source_type='mcq_pdf'}
  else{
    const pdfFile=$('#taStudyPdf')?.files?.[0]||null;
    const pastedText=$('#taStudyText')?.value?.trim()||'';
    const title=$('#taTitle')?.value?.trim()||'PDF generated quiz';
    if(pdfFile){
      quiz=await teacherGenerateQuizFromPdf(pdfFile,count,title);
      content='PDF: '+(pdfFile.name||'uploaded.pdf');
    }else if(pastedText.length>=50){
      content=pastedText;
      quiz=await teacherGenerateQuizFromText(content,count,title);
    }else{
      throw new Error('Upload a readable PDF first');
    }
    if(!quiz.length)throw new Error('Could not generate reliable MCQs from this PDF');
    source_type='study_pdf';
  }
  const questions=quiz.map(q=>{const options=(q.options||[]).map(String);let correct_index=options.indexOf(q.correct);if(correct_index<0)correct_index=Number.isInteger(q.correct_index)?q.correct_index:0;return {question:q.question,options,correct_index,explanation:q.explanation||''}});
  const due=$('#taDue')?.value||null;
  return {class_id:Number(cls.id),title:$('#taTitle')?.value?.trim()||'Untitled quiz',subject:$('#taSubject')?.value?.trim()||cls.subject||'General',instructions:$('#taInstructions')?.value?.trim()||'',source_type,source_content:content,question_count:questions.length||count,time_limit_minutes:Math.max(0,Math.min(300,parseInt($('#taTimeLimit')?.value||0,10)||0)),allow_retake:($('#taAllowRetake')?.value||'yes')==='yes',status:'published',due_at:due?new Date(due+'T23:59:59').toISOString():null,target_student_ids:[],questions};
}
createAssignment=async function(){
  const btn=$('#teacherAssignBtn');
  try{setBusy(btn,true);const payload=await aqgBuildAssignmentFromForm();await request('/api/v1/assignments',{method:'POST',body:JSON.stringify(payload)});['#taTitle','#taSubject','#taDue','#taInstructions','#taContent','#taDirectMcqs','#taMcqPdfText','#taStudyText'].forEach(id=>{const el=$(id);if(el)el.value=''});await syncAcademicPortal(false);showPanel('teacherAssignmentsPanel');toast('Quiz assigned and published to the class','success')}catch(e){toast(e.message||'Assignment failed','error')}finally{setBusy(btn,false)}
};
deleteAssignment=async function(id){if(!confirm('Delete this assignment?'))return;try{await request(`/api/v1/assignments/${id}`,{method:'DELETE'});await syncAcademicPortal(false);toast('Assignment deleted','success')}catch(e){toast(e.message,'error')}};

/* Direct quiz generation: skip the review/approval modal. */
generateQuiz=async function(){
  if(!SESSION)return toast('Sign in first','error');const btn=$('#genBtn');state.answered={};state.submitted=false;state.quiz=[];state.sessionId=null;state.lastResult=null;$('#scorePanel')?.classList.remove('show');
  try{setBusy(btn,true);let d;if(state.source==='pdf'){if(!state.pdf)throw new Error('Upload a PDF first');const fd=new FormData();fd.append('user_id',SESSION.user_id);fd.append('count',Math.min(getCount(),100));fd.append('quiz_title',$('#quizTitle').value.trim()||'PDF quiz');fd.append('file',state.pdf);d=await request('/api/v1/generate-quiz-pdf',{method:'POST',body:fd})}else{const text=$('#textData').value.trim();if(text.length<50)throw new Error('Paste at least 50 characters');d=await request('/api/v1/generate-quiz',{method:'POST',body:JSON.stringify({user_id:SESSION.user_id,text_content:text,count:Math.min(getCount(),100),quiz_title:$('#quizTitle').value.trim()||'AI quiz'})})}state.quiz=(d.quiz||[]).map(normalizeQuestion);state.sessionId=d.session_id||null;state.startedAt=Date.now();startTimer();renderQuiz();focusQuizMode(true);toast('Quiz generated successfully','success')}catch(e){toast(e.message||'Quiz generation failed','error');renderQuiz()}finally{setBusy(btn,false)}
};

/* ===== Robust top Settings trigger (Teacher + Student portals) ===== */
(function installSettingsTriggerFix(){
  function forceOpenSettings(){
    try{
      if(typeof renderSettings === 'function') renderSettings();
      const modal = document.getElementById('settingsModal');
      if(!modal) return;
      modal.classList.add('show');
      modal.style.display = 'grid';
      modal.setAttribute('aria-hidden','false');
      document.body.classList.add('modal-open');
      const first = modal.querySelector('button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if(first) setTimeout(()=>first.focus(),0);
    }catch(err){
      console.error('Unable to open settings', err);
      if(typeof toast === 'function') toast('Settings could not open. Please refresh once.','error');
    }
  }
  function forceCloseSettings(){
    const modal = document.getElementById('settingsModal');
    if(!modal) return;
    modal.classList.remove('show');
    modal.style.removeProperty('display');
    modal.setAttribute('aria-hidden','true');
    document.body.classList.remove('modal-open');
  }
  window.openSettings = forceOpenSettings;
  window.closeSettings = forceCloseSettings;

  document.addEventListener('click', function(event){
    const settingsButton = event.target.closest('.top-settings-btn');
    if(!settingsButton) return;
    event.preventDefault();
    event.stopPropagation();
    forceOpenSettings();
  }, true);

  function prepareButton(){
    document.querySelectorAll('.top-settings-btn').forEach(function(button){
      button.type = 'button';
      button.disabled = false;
      button.style.pointerEvents = 'auto';
      button.style.position = 'relative';
      button.style.zIndex = '60';
      button.setAttribute('aria-haspopup','dialog');
      button.setAttribute('aria-controls','settingsModal');
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prepareButton, {once:true});
  else prepareButton();
})();

/* ===== Robust teacher quiz assignment publishing fix ===== */
(function installTeacherAssignmentPublishFix(){
  async function publishTeacherAssignment(){
    const btn=document.getElementById('teacherAssignBtn');
    try{
      if(typeof setBusy==='function') setBusy(btn,true);
      if(!window.SESSION && typeof SESSION!=='undefined' && !SESSION) throw new Error('Please sign in again.');

      const payload=await aqgBuildAssignmentFromForm();
      if(!payload || !Number.isFinite(Number(payload.class_id))) throw new Error('Please select a valid class.');
      if(!Array.isArray(payload.questions)) payload.questions=[];

      const created=await request('/api/v1/assignments',{
        method:'POST',
        body:JSON.stringify(payload)
      });

      // Update the authoritative frontend cache immediately. A later refresh
      // failure must never make a successfully-created assignment look failed.
      if(created){
        const current=Array.isArray(AQG_SYNC?.assignments)?AQG_SYNC.assignments:[];
        AQG_SYNC.assignments=[created,...current.filter(a=>String(a.id)!==String(created.id))];
        try{ aqgCacheAssignments({assignments:AQG_SYNC.assignments}); }catch(cacheError){ console.warn('Assignment cache refresh skipped',cacheError); }
      }

      ['#taTitle','#taSubject','#taDue','#taInstructions','#taContent','#taDirectMcqs','#taMcqPdfText','#taStudyText'].forEach(selector=>{
        const el=document.querySelector(selector);if(el)el.value='';
      });
      ['#taMcqPdf','#taStudyPdf'].forEach(selector=>{const el=document.querySelector(selector);if(el)el.value='';});

      toast('Quiz generated and assigned successfully','success');

      // UI refresh is best-effort and cannot undo the successful API write.
      try{
        if(typeof syncAcademicPortal==='function') await syncAcademicPortal(true);
        if(typeof showPanel==='function') showPanel('teacherAssignmentsPanel');
        if(typeof renderTeacherAssignments==='function') renderTeacherAssignments();
        if(typeof renderTeacherDashboard==='function') renderTeacherDashboard();
      }catch(uiError){
        console.warn('Assignment saved; UI refresh needs a page reload',uiError);
        toast('Assignment saved. Refresh once to view it.','success');
      }
    }catch(error){
      console.error('Teacher assignment publish failed',error);
      const message=(error&&error.message)?error.message:'Quiz assignment failed. Check the server terminal for details.';
      toast(message,'error');
    }finally{
      if(typeof setBusy==='function') setBusy(btn,false);
    }
  }

  window.createAssignment=publishTeacherAssignment;
  document.addEventListener('click',function(event){
    const button=event.target.closest('#teacherAssignBtn');
    if(!button)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    publishTeacherAssignment();
  },true);
})();

/* FINAL TEACHER ANALYTICS + CLASS BADGE FIX */
function teacherVisibleClassCode(){
  try{
    const rows=typeof ensureTeacherClasses==='function'?ensureTeacherClasses():[];
    const backendInvite=String(
      rows?.[0]?.teacherCode||
      rows?.[0]?.teacher_code||
      ''
    ).trim().toUpperCase();
    if(backendInvite.startsWith('TCH-'))return backendInvite;
    const localInvite=typeof teacherCode==='function'
      ?String(teacherCode()||'').trim().toUpperCase()
      :'';
    return localInvite.startsWith('TCH-')?localInvite:'';
  }catch{return ''}
}
function refreshTeacherClassBadge(){
  if(!SESSION||getRole()!=='teacher')return;
  const el=$('#sideClassCode');
  if(el)el.textContent=teacherVisibleClassCode()||'No teacher code';
}
const __paintUserBeforeClassBadge=paintUser;
paintUser=function(){
  __paintUserBeforeClassBadge();
  refreshTeacherClassBadge();
};

function analyticsDateLabel(value){
  if(!value)return 'Not submitted';
  try{return new Date(value).toLocaleString()}catch{return String(value)}
}
function analyticsPctClass(pct){
  const n=Number(pct||0);
  return n>=75?'good':n>=50?'warn':'danger';
}
function analyticsStudentResultRow(row){
  const submitted=row.status==='submitted';
  const pct=submitted?Number(row.pct||0):null;
  return `<article class="ta-student-result ${submitted?'submitted':'pending'}">
    <div class="ta-student-identity">
      <b>${safe(row.studentName||'Student')}</b>
      <small>${safe(row.studentCode||'No code')} · ${safe(row.studentEmail||'No email')}</small>
    </div>
    <div class="ta-result-cell"><span>Status</span><b class="${submitted?'status-good':'status-pending'}">${submitted?'Submitted':'Pending'}</b></div>
    <div class="ta-result-cell"><span>Attempt</span><b>${submitted?safe(row.attemptNo||1):'—'}</b></div>
    <div class="ta-result-cell"><span>Marks</span><b>${submitted?`${safe(row.score||0)} / ${safe(row.total||0)}`:'—'}</b></div>
    <div class="ta-result-cell"><span>Correct</span><b>${submitted?safe(row.correct||0):'—'}</b></div>
    <div class="ta-result-cell"><span>Wrong</span><b>${submitted?safe(row.wrong||0):'—'}</b></div>
    <div class="ta-result-cell"><span>Percentage</span><b class="${submitted?analyticsPctClass(pct):''}">${submitted?`${pct}%`:'—'}</b></div>
    <div class="ta-result-cell ta-date-cell"><span>Submitted</span><b>${safe(analyticsDateLabel(row.submittedAt))}</b></div>
  </article>`;
}
function analyticsAssignmentDetailHTML(report){
  const a=report.assignment||{},s=report.summary||{},students=report.students||[],weak=report.weakQuestions||[];
  const studentRows=students.length?students.map(analyticsStudentResultRow).join(''):`<div class="assignment-empty-slim"><h3>No students assigned</h3><p>Join students to the class or target students before publishing.</p></div>`;
  const weakRows=weak.length?weak.map(q=>`<div class="ta-weak-row"><span>Q${safe(q.position)}</span><div><b>${safe(q.question)}</b><small>${safe(q.correct)} correct · ${safe(q.wrong)} wrong · ${safe(q.accuracy)}% accuracy</small></div></div>`).join(''):'<div class="hint">Question difficulty will appear after students submit.</div>';
  return `<div class="ta-detail-top"><div><span class="badge brand">Selected assignment</span><h3>${safe(a.title||'Untitled assignment')}</h3><p>${safe(a.subject||'General')} · Due ${safe(a.dueAt||a.due||'No due date')}</p></div><div class="ta-detail-actions"><button class="btn ghost small" onclick="window.open(API+'/api/v1/analytics/assignments/${Number(a.id)}/export.csv','_blank')">Export CSV</button></div></div>
  <div class="ta-detail-kpis"><div><span>Assigned</span><b>${safe(s.assigned||0)}</b></div><div><span>Submitted</span><b>${safe(s.submitted||0)}</b></div><div><span>Pending</span><b>${safe(s.pending||0)}</b></div><div><span>Completion</span><b>${safe(s.completionRate||0)}%</b></div><div><span>Average</span><b>${safe(s.average||0)}%</b></div><div><span>Highest</span><b>${safe(s.highest||0)}%</b></div><div><span>Lowest</span><b>${safe(s.lowest||0)}%</b></div></div>
  <div class="ta-results-header"><div><h4>Student results</h4><p>Every assigned student, marks, percentage, attempt and pending status.</p></div><span class="badge">${students.length} student${students.length===1?'':'s'}</span></div>
  <div class="ta-student-results-list">${studentRows}</div>
  <div class="ta-results-header ta-weak-head"><div><h4>Question difficulty</h4><p>Questions with the lowest accuracy.</p></div></div>
  <div class="ta-weak-list">${weakRows}</div>`;
}

function closeAnalyticsAssignmentScreen(){
  const screen=document.getElementById('analyticsAssignmentScreen');
  if(screen)screen.remove();
  document.body.classList.remove('analytics-screen-open');
}
function openAnalyticsAssignmentScreenShell(){
  closeAnalyticsAssignmentScreen();
  const screen=document.createElement('div');
  screen.id='analyticsAssignmentScreen';
  screen.className='analytics-assignment-screen';
  screen.innerHTML=`<div class="analytics-screen-card"><header class="analytics-screen-header"><div><span class="badge brand">Assignment report</span><h2>Student progress</h2><p>Verified marks and submission status for this assignment.</p></div><button class="btn ghost" type="button" onclick="closeAnalyticsAssignmentScreen()">← Back to analytics</button></header><main id="analyticsAssignmentScreenBody" class="analytics-screen-body"><div class="assignment-empty-slim"><h3>Loading student results…</h3></div></main></div>`;
  document.body.appendChild(screen);
  document.body.classList.add('analytics-screen-open');
  screen.addEventListener('click',e=>{if(e.target===screen)closeAnalyticsAssignmentScreen()});
  return screen.querySelector('#analyticsAssignmentScreenBody');
}
async function analyticsOpenAssignment(code,id){
  state.activeAnalyticsClassCode=String(code||'').toUpperCase();
  state.activeAnalyticsAssignmentId=Number(id)||id;
  const detail=openAnalyticsAssignmentScreenShell();
  try{
    const report=await request('/api/v1/analytics/assignments/'+encodeURIComponent(id));
    if(detail)detail.innerHTML=analyticsAssignmentDetailHTML(report);
  }catch(e){
    if(detail)detail.innerHTML=`<div class="assignment-empty-slim"><h3>Could not load results</h3><p>${safe(messageText(e))}</p><button class="btn primary small" onclick="analyticsOpenAssignment('${safe(code)}','${safe(id)}')">Try again</button></div>`;
    toast(messageText(e),'error');
  }
}

async function renderTeacherAnalytics(){
  const out=$('#teacherAnalyticsOut');
  if(!out||!SESSION||getRole()!=='teacher')return;
  out.innerHTML='<div class="assignment-empty-slim"><h3>Loading class analytics…</h3></div>';
  try{
    const data=await request('/api/v1/analytics/teacher/overview');
    const summary=data.summary||{},classes=data.classes||[];
    if(classes.length){
      const cached=classes.map(c=>({
        ...c,
        code:String(c.code||c.classCode||'').toUpperCase(),
        classCode:String(c.code||c.classCode||'').toUpperCase(),
        className:c.className||c.name||'Academic Class',
        classKey:c.classKey||'',
        assignments:c.assignments||[]
      }));
      writeJSON(teacherClassesKey(),cached);
      const activeNow=String(state.activeAnalyticsClassCode||activeTeacherClassCode()||cached[0].code).toUpperCase();
      state.activeAnalyticsClassCode=cached.some(c=>c.code===activeNow)?activeNow:cached[0].code;
      writeJSON(profileKey(),{...profileDetails(),activeClassCode:state.activeAnalyticsClassCode});
      refreshTeacherClassBadge();
    }
    const active=String(state.activeAnalyticsClassCode||classes[0]?.code||classes[0]?.classCode||'').toUpperCase();
    const activeClass=classes.find(c=>String(c.code||c.classCode||'').toUpperCase()===active)||classes[0]||null;
    const classCards=classes.length?classes.map(c=>{
      const code=String(c.code||c.classCode||'').toUpperCase(),selected=activeClass&&code===String(activeClass.code||activeClass.classCode||'').toUpperCase();
      return `<article class="ta-class-card ${selected?'active':''}"><div class="ta-class-top"><div><div class="ta-class-name">${safe(c.className||'Academic Class')}</div><div class="ta-class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span></div></div>${selected?'<span class="badge good">Selected</span>':''}</div><div class="ta-class-stats"><div><span>Students</span><b>${safe(c.studentCount||0)}</b></div><div><span>Assessments</span><b>${safe(c.assignmentCount||0)}</b></div><div><span>Average</span><b>${safe(c.average||0)}%</b></div></div><div class="ta-class-actions"><button class="btn primary small" onclick="state.activeAnalyticsClassCode='${safe(code)}';state.activeAnalyticsAssignmentId=null;renderTeacherAnalytics()">${selected?'Refresh class':'Open class'}</button></div></article>`;
    }).join(''):`<div class="assignment-empty-slim"><h3>No class available</h3><p>Create a class and add students first.</p></div>`;
    let workspace='';
    if(activeClass){
      const assignments=activeClass.assignments||[];
      const selectedId=state.activeAnalyticsAssignmentId;
      const assignmentList=assignments.length?assignments.map(a=>{
        const an=a.analytics||{},selected=String(a.id)===String(selectedId);
        return `<article class="ta-assignment-item ${selected?'active':''}" onclick="analyticsOpenAssignment('${safe(active)}','${safe(a.id)}')" role="button" tabindex="0"><div><span class="badge brand">${safe(a.assignmentType||a.sourceType||'Quiz')}</span><h4>${safe(a.title||'Untitled quiz')}</h4><p>${safe(a.subject||activeClass.subject||'General')} · ${safe(an.submitted||0)}/${safe(an.assigned||0)} submitted · ${safe(an.average||0)}% average</p></div><div class="ta-assignment-progress"><div style="width:${Math.min(100,Number(an.completionRate||0))}%"></div></div><div class="ta-assignment-bottom"><span class="ta-assignment-numbers">${safe(an.completionRate||0)}% complete · ${safe(an.pending||0)} pending</span><button class="btn ${selected?'good':'primary'} small" onclick="event.stopPropagation();analyticsOpenAssignment('${safe(active)}','${safe(a.id)}')">${selected?'Viewing':'View students'}</button></div></article>`;
      }).join(''):`<div class="assignment-empty-slim"><h3>No assignments yet</h3><p>Publish an assignment to view student progress.</p></div>`;
      workspace=`<section class="ta-section"><div class="ta-active-head"><div><span class="badge brand">Selected class · ${safe(active)}</span><h2>${safe(activeClass.className||'Academic Class')}</h2><p>${safe(activeClass.subject||'General')} · ${safe(activeClass.studentCount||0)} students · ${safe(activeClass.assignmentCount||0)} assignments</p></div></div><div class="ta-workspace"><div class="ta-pane"><div class="ta-pane-head"><div><h4>Class assessments</h4><p>Click any assignment to open every student's result.</p></div><span class="badge">${assignments.length}</span></div><div class="ta-scroll"><div class="ta-assignment-list">${assignmentList}</div></div></div><div class="ta-pane ta-open-report-pane"><div class="ta-pane-head"><div><h4>Open full report</h4><p>Assignment results now open on a separate full screen.</p></div></div><div class="ta-detail-empty"><div class="assignment-empty-slim"><h3>Select an assignment</h3><p>Click View students to open the complete student report on the next screen.</p></div></div></div></div></section>`;
    }
    out.innerHTML=`<div class="ta-dashboard"><section class="ta-hero"><div><span class="hero-kicker">Teacher intelligence workspace</span><h2>Class analytics</h2><p>Open an assignment to inspect every student's marks, percentage, attempt number and submission status.</p></div></section><div class="ta-kpis"><div class="ta-kpi"><span>Total classes</span><b>${safe(summary.classes||0)}</b></div><div class="ta-kpi"><span>Assessments</span><b>${safe(summary.assignments||0)}</b></div><div class="ta-kpi"><span>Students</span><b>${safe(summary.students||0)}</b></div><div class="ta-kpi"><span>Overall average</span><b>${safe(summary.average||0)}%</b></div></div><section class="ta-section"><div class="ta-section-head"><div><h3>Choose a class</h3><p>Each class keeps its own assessments and results.</p></div></div><div class="ta-class-grid">${classCards}</div></section>${workspace}</div>`;
    if(selectedId&&activeClass?.assignments?.some(a=>String(a.id)===String(selectedId)))analyticsOpenAssignment(active,selectedId);
  }catch(e){
    out.innerHTML=`<div class="assignment-empty-slim"><h3>Analytics could not load</h3><p>${safe(messageText(e))}</p><button class="btn primary small" onclick="renderTeacherAnalytics()">Try again</button></div>`;
    toast(messageText(e),'error');
  }
}


/* =============================================================
   SECURE ASSIGNMENT ATTEMPTS + DATABASE TEACHER PROGRESS FIX
   - Student assignment attempts now use Phase 4 backend APIs.
   - Teacher Assessments progress now reads Phase 5 database analytics.
   ============================================================= */
(function installSecureAssignmentProgressFix(){
  state.assignmentAttemptId = state.assignmentAttemptId || null;
  state.assignmentAttemptQuestionIds = state.assignmentAttemptQuestionIds || [];

  function assignmentAnswerPayload(){
    const answers={};
    (state.quiz||[]).forEach((q,index)=>{
      if(state.answered[index]===undefined || state.answered[index]===null)return;
      const qid=q.backendQuestionId||q.id;
      if(qid!==undefined && qid!==null)answers[String(qid)]=Number(state.answered[index]);
    });
    return answers;
  }

  function applyAssignmentReview(review){
    const byId=new Map((review||[]).map(r=>[String(r.question_id),r]));
    state.quiz=(state.quiz||[]).map(q=>{
      const row=byId.get(String(q.backendQuestionId||q.id));
      if(!row)return q;
      const options=Array.isArray(q.options)?q.options:[];
      return {...q,correct_index:row.correct_index,correct:options[row.correct_index]||q.correct||''};
    });
  }

  async function openSecureAssignment(a){
    const code=a.joinedClassCode||a.classCode||'';
    const meta=teacherClassMeta(code);
    const data=await request(`/api/v1/assignments/${encodeURIComponent(a.id)}/attempts/start`,{method:'POST'});
    const attempt=data.attempt||{};
    const questions=Array.isArray(data.questions)?data.questions:[];
    if(!questions.length)throw new Error('This assignment has no questions.');

    state.assignmentAttemptId=attempt.attempt_id;
    state.assignmentAttemptQuestionIds=questions.map(q=>q.id);
    state.currentSessionAssignmentMeta=null;
    state.activeAssignmentMeta={
      origin:'teacher',
      assignmentId:a.id,
      assignmentTitle:a.title,
      title:a.title,
      classCode:code,
      className:a.className||meta.className,
      teacherName:a.teacherName||meta.teacherName,
      teacherCode:a.teacherCode||meta.teacherCode||'',
      subject:a.subject||meta.subject||'General',
      due:a.due||a.dueAt||'',
      instructions:a.instructions||'',
      count:questions.length,
      assignmentType:a.assignmentType||a.sourceType||''
    };
    state.quiz=questions.map((q,i)=>normalizeQuestion({
      ...q,
      id:q.id,
      backendQuestionId:q.id,
      question:q.question||q.question_body,
      correct:'',
      correct_index:null
    },i));
    state.answered={};
    const saved=attempt.answers||{};
    state.quiz.forEach((q,i)=>{
      const value=saved[String(q.backendQuestionId||q.id)];
      if(value!==undefined && value!==null)state.answered[i]=Number(value);
    });
    state.submitted=false;
    state.lastResult=null;
    state.sessionId=null;
    state.filter='all';
    state.mcqPrompted=false;
    $('#scorePanel')?.classList.remove('show');
    if($('#quizTitle'))$('#quizTitle').value=a.title||'Assigned quiz';
    if($('#customCount'))$('#customCount').value=state.quiz.length;
    showPanel('generatePanel');
    startTimer();
    renderQuiz();
    focusQuizMode(true);
    toast(attempt.attempt_no>1?`Retake ${attempt.attempt_no} started`:'Assignment started','success');
  }

  window.startAssignment=async function(id){
    const a=getStudentAssignments().find(x=>String(x.id)===String(id));
    if(!a)return toast('Assignment not found. Refresh the page.','error');
    try{await openSecureAssignment(a)}
    catch(e){toast(messageText(e,'Could not start assignment.'),'error')}
  };
  window.directStartAssignedQuiz=openSecureAssignment;

  const baseSelectAnswer=window.selectAnswer||selectAnswer;
  window.selectAnswer=function(i,j){
    baseSelectAnswer(i,j);
    if(!state.assignmentAttemptId||state.submitted)return;
    clearTimeout(state.assignmentAutosaveTimer);
    state.assignmentAutosaveTimer=setTimeout(async()=>{
      try{
        await request(`/api/v1/assignment-attempts/${state.assignmentAttemptId}/answers`,{
          method:'PATCH',
          body:JSON.stringify({answers:assignmentAnswerPayload()})
        });
      }catch(e){console.warn('Assignment autosave failed',e)}
    },350);
  };
  selectAnswer=window.selectAnswer;

  async function finishSecureAssignment(){
    const response=await request(`/api/v1/assignment-attempts/${state.assignmentAttemptId}/submit`,{
      method:'POST',
      body:JSON.stringify({answers:assignmentAnswerPayload()})
    });
    const result=response.result||{};
    if(response.already_submitted && response.attempt){
      result.score=response.attempt.score||0;
      result.total=response.attempt.total||state.quiz.length;
      result.pct=Math.round((result.score/Math.max(1,result.total))*100);
      result.answered=response.attempt.answered_count||0;
      result.wrong=Math.max(0,result.answered-result.score);
      result.skipped=Math.max(0,result.total-result.answered);
    }
    applyAssignmentReview(result.review||[]);
    state.submitted=true;
    clearInterval(state.timer);
    const score=Number(result.score||0),total=Number(result.total||state.quiz.length);
    const answered=Number(result.answered??Object.keys(state.answered).length);
    const wrong=Number(result.wrong??Math.max(0,answered-score));
    const skipped=Number(result.skipped??Math.max(0,total-answered));
    const pct=Number(result.pct??Math.round(score/Math.max(1,total)*100));
    const title=$('#quizTitle')?.value?.trim()||state.activeAssignmentMeta?.assignmentTitle||'Assigned quiz';
    const time=$('#timerBadge')?.textContent||'00:00';
    const at=new Date().toLocaleString();
    state.lastResult={score,total,answered,wrong,skipped,pct,title,time,at,comparison:null};
    $('#scorePanel')?.classList.add('show');
    if($('#scorePanel'))$('#scorePanel').innerHTML=`<div class="quiz-result-card"><div><div class="badge good">ASSIGNMENT SUBMITTED</div><h3 class="result-title">${safe(resultBand(pct))}</h3><div class="muted">${pct}% score · ${score}/${total} correct · securely saved for your teacher</div></div><div class="quick-actions"><button class="btn primary small" onclick="openStoredResultPop()">View Result Card</button><button class="btn ghost small" onclick="showPanel('sAssignmentsPanel')">Back to Assessments</button></div></div>`;
    renderQuiz();
    storeLocalAttempt(score,total,pct,null);
    saveAutoWeakQuiz(score,total,pct,answered,wrong,skipped,title,time,at);
    try{await syncAcademicPortal(true)}catch(e){console.warn(e)}
    renderStudentAssignments();
    renderStudentDashboard();
    renderStats();
    renderRevision();
    openStoredResultPop();
    toast('Assignment submitted to teacher','success');
    state.assignmentAttemptId=null;
    state.assignmentAttemptQuestionIds=[];
  }

  const personalSubmitQuiz=window.submitQuiz||submitQuiz;
  window.submitQuiz=async function(){
    if(!state.assignmentAttemptId)return personalSubmitQuiz();
    if(!state.quiz.length)return;
    try{await finishSecureAssignment()}
    catch(e){toast(messageText(e,'Assignment submission failed.'),'error')}
  };
  submitQuiz=window.submitQuiz;

  const personalEndQuiz=window.endQuizWithoutAttempt||endQuizWithoutAttempt;
  window.endQuizWithoutAttempt=async function(){
    if(!state.assignmentAttemptId)return personalEndQuiz();
    if(!confirm('End and submit this assignment with unanswered questions?'))return;
    try{state.answered={};await finishSecureAssignment()}
    catch(e){toast(messageText(e,'Could not end assignment.'),'error')}
  };
  endQuizWithoutAttempt=window.endQuizWithoutAttempt;

  function assignmentLookupById(id){
    return (AQG_SYNC.assignments||[]).find(a=>String(a.id)===String(id))||
      readJSON(assignmentsKey(),[]).find(a=>String(a.id)===String(id))||{};
  }


  window.previewPortalQuiz=function(id){
    const numericId=Number(id);
    let quiz=null;
    for(const classRow of portalState.classes||[]){
      const found=(classRow.assignments||[]).find(item=>Number(item.id||item.assignmentId)===numericId);
      if(found){quiz=found;break}
    }
    if(!quiz){
      const activeCode=classCodeOf(activeTeacherClass());
      quiz=(assignmentsFor(activeCode)||[]).find(item=>Number(item.id||item.assignmentId)===numericId)||null;
    }
    if(!quiz)return toast('Quiz preview could not be loaded','error');

    const panel=document.getElementById('teacherAssignmentsPanel');
    const box=document.getElementById('teacherInlineAssignmentPreview');
    if(!panel||!box)return toast('Preview area is not available','error');

    panel.classList.add('inline-preview-open');

    const title=quiz.title||'Untitled quiz';
    const className=quiz.className||activeTeacherClass()?.className||'Academic Class';
    const classCode=assignmentClassCode(quiz)||classCodeOf(activeTeacherClass())||'';
    const subject=quiz.subject||activeTeacherClass()?.subject||'General';
    const due=quiz.dueAt||quiz.due||quiz.due_at||'No due date';
    const questions=Array.isArray(quiz.questions)?quiz.questions:
      Array.isArray(quiz.quiz)?quiz.quiz:
      Array.isArray(quiz.mcqs)?quiz.mcqs:[];

    const questionHTML=questions.length
      ?questions.map((q,index)=>{
        const question=q.question||q.question_body||q.prompt||q.text||`Question ${index+1}`;
        const options=Array.isArray(q.options)?q.options:
          Array.isArray(q.choices)?q.choices:
          Array.isArray(q.answers)?q.answers:[];
        const correctIndex=Number.isInteger(q.correct_index)?q.correct_index:
          Number.isInteger(q.correctIndex)?q.correctIndex:null;
        const correctText=String(q.correct||q.correctAnswer||q.correct_answer||'').trim();
        const optionHTML=options.map((option,optionIndex)=>{
          const value=typeof option==='object'
            ?String(option.text??option.label??option.value??'')
            :String(option??'');
          const isCorrect=correctIndex===optionIndex||
            (!!correctText&&value.trim().toLowerCase()===correctText.toLowerCase());
          return `<div class="quiz-preview-option ${isCorrect?'correct':''}">
            <b>${String.fromCharCode(65+optionIndex)}.</b><span>${safe(value)}</span>
          </div>`;
        }).join('');
        return `<article class="quiz-preview-question">
          <span>Question ${index+1}</span>
          <h3>${safe(question)}</h3>
          <div class="quiz-preview-options">${optionHTML||'<div class="muted">Options were not stored.</div>'}</div>
        </article>`;
      }).join('')
      :`<div class="assignment-empty-slim"><h3>No stored questions</h3><p>This quiz has no previewable question data.</p></div>`;

    box.innerHTML=`<section class="teacher-quiz-preview">
      <div class="teacher-quiz-preview-head">
        <div>
          <span class="badge brand">Quiz preview</span>
          <h2>${safe(title)}</h2>
          <p>${safe(className)} · ${safe(classCode)} · ${safe(subject)}</p>
        </div>
        <button class="btn ghost small" type="button" onclick="closeTeacherAssignmentPreview()">Close preview</button>
      </div>
      <div class="teacher-quiz-preview-meta">
        <div><span>Questions</span><b>${questions.length||quiz.questionCount||quiz.count||0}</b></div>
        <div><span>Subject</span><b>${safe(subject)}</b></div>
        <div><span>Due</span><b>${safe(String(due))}</b></div>
        <div><span>Retake</span><b>${quiz.allowRetake===false?'Not allowed':'Allowed'}</b></div>
      </div>
      <div class="teacher-quiz-preview-list">${questionHTML}</div>
    </section>`;

    requestAnimationFrame(()=>box.scrollIntoView({behavior:'smooth',block:'start'}));
  };

  window.renderTeacherAssignments=async function(){
    const out=$('#teacherAssignmentsOut');
    if(!out||!SESSION||getRole()!=='teacher')return;
    const classList=$('#teacherAssignmentClassList');
    const prog=$('#teacherAssignmentProgressOut');
    if(prog)prog.innerHTML='<div class="assignment-empty-slim"><h3>Loading verified progress…</h3></div>';
    try{
      const data=await request('/api/v1/analytics/teacher/overview');
      const classes=data.classes||[];
      if(classes.length){
        const cached=classes.map(c=>({
          ...c,
          code:String(c.code||c.classCode||'').toUpperCase(),
          classCode:String(c.code||c.classCode||'').toUpperCase(),
          className:c.className||c.name||'Academic Class'
        }));
        writeJSON(teacherClassesKey(),cached);
      }
      let active=String(state.activeTeacherAssignmentsClassCode||activeTeacherClassCode()||classes[0]?.code||classes[0]?.classCode||'').toUpperCase();
      let activeClass=classes.find(c=>String(c.code||c.classCode||'').toUpperCase()===active)||classes[0]||null;
      if(activeClass){
        active=String(activeClass.code||activeClass.classCode||'').toUpperCase();
        state.activeTeacherAssignmentsClassCode=active;
        writeJSON(profileKey(),{...profileDetails(),activeClassCode:active});
        refreshTeacherClassBadge();
      }
      setTextSafe('teacherAssignmentClassBadge',classes.length+' class'+(classes.length===1?'':'es'));
      if(classList)classList.innerHTML=classes.length?classes.map(c=>{
        const code=String(c.code||c.classCode||'').toUpperCase();
        const selected=code===active;
        return `<div class="assignment-pro-class-card ${selected?'active':''}"><div><span class="class-kicker">Teacher class</span><div class="class-title">${safe(c.className||'Academic Class')}</div><div class="class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span></div></div><div class="assignment-mini-stats"><div><span>Students</span><b>${safe(c.studentCount||0)}</b></div><div><span>Assessments</span><b>${safe(c.assignmentCount||0)}</b></div><div><span>Average</span><b>${safe(c.average||0)}%</b></div></div><div class="class-actions"><button class="btn primary small" onclick="selectTeacherAssignmentClass('${safe(code)}')">Open class</button><button class="btn ghost small" onclick="teacherAssignToClass('${safe(code)}')">Create</button></div></div>`;
      }).join(''):'<div class="assignment-empty-slim"><h3>No class yet</h3><p>Create a class first.</p></div>';

      if(!activeClass){
        if(prog)prog.innerHTML='<div class="assignment-empty-slim"><h3>No selected class</h3></div>';
        out.innerHTML='<div class="assignment-empty-slim"><h3>No assessments yet</h3></div>';
        return;
      }
      const rows=activeClass.assignments||[];
      setTextSafe('teacherAssignmentListBadge',rows.length+' assessments');
      setTextSafe('teacherAssignmentWorkspaceTitle',(activeClass.className||'Selected class')+' progress');
      setTextSafe('teacherAssignmentWorkspaceHint',`${activeClass.studentCount||0} students · ${rows.length} assessments · ${activeClass.submissionCount||0} verified submissions`);
      if(prog)prog.innerHTML=`<div class="assignment-progress-summary"><div><span>Students</span><b>${safe(activeClass.studentCount||0)}</b></div><div><span>Assessments</span><b>${safe(rows.length)}</b></div><div><span>Submissions</span><b>${safe(activeClass.submissionCount||0)}</b></div><div><span>Average</span><b>${safe(activeClass.average||0)}%</b></div></div>${rows.length?rows.map(row=>{
        const an=row.analytics||{};
        return `<div class="assignment-progress-row" role="button" tabindex="0" onclick="showPanel('teacherAnalyticsPanel');setTimeout(()=>analyticsOpenAssignment('${safe(active)}','${safe(row.id)}'),80)"><div><span>${safe(row.sourceType||'Created quiz')} · ${safe(row.subject||activeClass.subject||'General')}</span><h3>${safe(row.title||'Untitled quiz')}</h3><p>${safe(an.submitted||0)}/${safe(an.assigned||0)} students submitted · ${safe(an.pending||0)} pending · average ${safe(an.average||0)}%</p><div class="assignment-progress-bar"><div style="width:${Math.min(100,Number(an.completionRate||0))}%"></div></div></div><div class="assignment-progress-pct">${safe(an.completionRate||0)}%</div></div>`;
      }).join(''):'<div class="assignment-empty-slim"><h3>No assessments yet</h3><p>Create an assessment for this class.</p></div>'}`;

      out.innerHTML=rows.length?rows.map(row=>{
        const an=row.analytics||{},a={...assignmentLookupById(row.id),...row};
        return `<div class="assignment-pro-card"><div><span class="assignment-class-title">${safe(activeClass.className||'Class')} · ${safe(active)}</span><h3>${safe(row.title||'Untitled quiz')}</h3><p class="muted">${safe(row.subject||activeClass.subject||'General')} · ${safe(an.submitted||0)}/${safe(an.assigned||0)} submitted · avg ${safe(an.average||0)}%</p><div class="assignment-pro-meta"><span class="badge brand">Verified database</span><span class="badge">${safe(an.completionRate||0)}% complete</span><span class="badge">${safe(an.pending||0)} pending</span><span class="badge good">${safe(an.submitted||0)} submitted</span></div></div><div class="assignment-pro-actions"><button class="btn primary small" onclick="showPanel('teacherAnalyticsPanel');setTimeout(()=>analyticsOpenAssignment('${safe(active)}','${safe(row.id)}'),80)">View results</button><button class="btn danger small" onclick="deleteAssignment(${safe(row.id)})">Delete</button></div></div>`;
      }).join(''):'<div class="assignment-empty-slim"><h3>No assessment in this class</h3><p>Publish a quiz first.</p></div>';
    }catch(e){
      if(prog)prog.innerHTML=`<div class="assignment-empty-slim"><h3>Progress could not load</h3><p>${safe(messageText(e))}</p></div>`;
      out.innerHTML=`<div class="assignment-empty-slim"><h3>Assessments could not load</h3><p>${safe(messageText(e))}</p><button class="btn primary small" onclick="renderTeacherAssignments()">Try again</button></div>`;
    }
  };
  renderTeacherAssignments=window.renderTeacherAssignments;

  function setTextSafe(id,value){const el=document.getElementById(id);if(el)el.textContent=value}
})();



/* =====================================================================
   FINAL AUTHORITATIVE PORTAL STABILITY PATCH
   Uses backend/database as the only academic source of truth.
   Fixes duplicate legacy function overrides for classes, assignments,
   secure attempts, teacher progress and inline result reports.
   ===================================================================== */
(function installAuthoritativePortalPatch(){
  const portalState={
    classes:[],
    assignments:[],
    discovered:[],
    analytics:null,
    syncing:false,
    ready:false,
    selectedStudentClass:'',
    selectedTeacherClass:'',
    openResultAssignmentId:null,
    myAttempts:{},
    studentCode:''
  };

  function classCodeOf(row){return String(row?.code||row?.classCode||'').trim().toUpperCase()}
  function classIdOf(row){const n=Number(row?.id||row?.classId);return Number.isFinite(n)?n:null}
  function assignmentClassCode(row){return String(row?.classCode||row?.joinedClassCode||'').trim().toUpperCase()}
  function assignmentIdOf(row){const n=Number(row?.id||row?.assignmentId);return Number.isFinite(n)?n:null}
  function setText(id,value){const el=document.getElementById(id);if(el)el.textContent=String(value??'')}
  function currentRole(){return typeof getRole==='function'?getRole():String(SESSION?.role||'student').toLowerCase()}
  function classByCode(code){const c=String(code||'').toUpperCase();return portalState.classes.find(x=>classCodeOf(x)===c)||portalState.discovered.find(x=>classCodeOf(x)===c)||null}
  function activeTeacherClass(){
    const code=String(portalState.selectedTeacherClass||state.activeTeacherClassCode||'').toUpperCase();
    return classByCode(code)||portalState.classes[0]||null;
  }
  function activeStudentClass(){
    const joined=portalState.classes;
    const code=String(portalState.selectedStudentClass||state.activeStudentClassCode||'').toUpperCase();
    return joined.find(x=>classCodeOf(x)===code)||joined[0]||null;
  }
  function assignmentsFor(code){
    const c=String(code||'').toUpperCase();
    return portalState.assignments.filter(a=>assignmentClassCode(a)===c);
  }
  function dateLabel(value){
    if(!value)return 'No due date';
    try{return new Date(value).toLocaleDateString()}catch{return String(value)}
  }
  function pct(value){const n=Number(value||0);return Number.isFinite(n)?Math.round(n*100)/100:0}

  // Authoritative compatibility adapters. Legacy UI helpers now read memory
  // populated from backend, never browser academic caches.
  window.ensureTeacherClasses=function(){return portalState.classes.slice()};
  window.studentClassRows=function(){return portalState.classes.map(c=>({...c,status:'joined'}))};
  window.studentJoinedCodes=function(){return portalState.classes.map(classCodeOf).filter(Boolean)};
  window.getStudentAssignments=function(){return portalState.assignments.slice()};
  window.teacherClassMeta=function(code){
    const c=classByCode(code)||{};
    return {
      id:classIdOf(c),code:classCodeOf(c),classCode:classCodeOf(c),
      className:c.className||c.name||'Academic Class',
      subject:c.subject||'General',section:c.section||'',
      teacherName:c.teacherName||'Teacher',teacherCode:c.teacherCode||'',
      classKey:c.classKey||''
    };
  };
  window.activeTeacherClassCode=function(){return classCodeOf(activeTeacherClass())};
  window.currentSelectedTeacherAssignmentClass=function(){return classCodeOf(activeTeacherClass())};

  async function fetchPortalData(){
    if(!SESSION)return;
    const [classData,assignmentData]=await Promise.all([
      request('/api/v1/classes/mine'),
      request('/api/v1/assignments/mine')
    ]);
    portalState.classes=Array.isArray(classData?.classes)?classData.classes:[];
    portalState.studentCode=String(classData?.studentCode||'').trim().toUpperCase();
    portalState.assignments=Array.isArray(assignmentData?.assignments)?assignmentData.assignments:[];
    if(currentRole()==='student'){
      const attemptPairs=await Promise.all(portalState.assignments.map(async a=>{
        const id=assignmentIdOf(a);
        if(!id)return [String(id),[]];
        try{
          const data=await request(`/api/v1/assignments/${id}/attempts/mine`);
          return [String(id),Array.isArray(data?.attempts)?data.attempts:[]];
        }catch(error){
          console.warn('Could not load student attempts for assignment',id,error);
          return [String(id),[]];
        }
      }));
      portalState.myAttempts=Object.fromEntries(attemptPairs);
    }else{
      portalState.myAttempts={};
    }
    if(currentRole()==='teacher'){
      if(!portalState.classes.some(c=>classCodeOf(c)===portalState.selectedTeacherClass)){
        portalState.selectedTeacherClass=classCodeOf(portalState.classes[0]);
      }
    }else if(!portalState.classes.some(c=>classCodeOf(c)===portalState.selectedStudentClass)){
      portalState.selectedStudentClass=classCodeOf(portalState.classes[0]);
    }
    portalState.ready=true;
  }

  let portalSyncPromise=null;
  let portalSyncQueued=false;
  window.syncAcademicPortal=async function(silent=true,force=false){
    if(!SESSION)return false;
    if(portalSyncPromise){
      if(force)portalSyncQueued=true;
      await portalSyncPromise;
      if(force||portalSyncQueued){
        portalSyncQueued=false;
        return window.syncAcademicPortal(silent,false);
      }
      return true;
    }
    portalState.syncing=true;
    portalSyncPromise=(async()=>{
      try{
        await fetchPortalData();
        if(typeof paintUser==='function')paintUser();
        if(currentRole()==='teacher'){
          renderTeacherClassSelect?.();
          renderTeacherDashboard?.();
          renderTeacherStudents?.();
          await window.renderTeacherAssignments();
        }else{
          window.renderStudentAssignments();
          renderStudentDashboard?.();
        }
        return true;
      }catch(error){
        console.error('Portal synchronization failed',error);
        if(!silent)toast(messageText(error,'Could not synchronize portal data.'),'error');
        return false;
      }finally{
        portalState.syncing=false;
      }
    })();
    try{return await portalSyncPromise}
    finally{
      portalSyncPromise=null;
      if(portalSyncQueued){
        portalSyncQueued=false;
        setTimeout(()=>window.syncAcademicPortal(true,true),0);
      }
    }
  };

  // Keep profile badge grounded in backend classes.
  const priorPaintUser=window.paintUser||paintUser;
  window.paintUser=function(){
    priorPaintUser();
    const el=document.getElementById('sideClassCode');
    if(!el)return;
    if(currentRole()==='teacher'){
      const active=activeTeacherClass()||{};
      const invite=String(
        active.teacherCode||
        active.teacher_code||
        portalState.classes?.[0]?.teacherCode||
        portalState.classes?.[0]?.teacher_code||
        (typeof teacherCode==='function'?teacherCode():'')||
        ''
      ).trim().toUpperCase();
      el.textContent=invite.startsWith('TCH-')?invite:'No teacher code';
    }else{
      const count=portalState.classes.length;
      el.textContent=count?`${count} class${count===1?'':'es'}`:'No class';
    }
  };
  paintUser=window.paintUser;

  // -------- Class discovery and joining --------
  window.findTeacherClasses=async function(){
    const input=document.getElementById('joinClassCode');
    const code=String(input?.value||'').trim().toUpperCase();
    if(!code)return toast('Enter teacher code or class code','error');
    try{
      const data=await request('/api/v1/classes/discover/'+encodeURIComponent(code));
      portalState.discovered=Array.isArray(data?.classes)?data.classes:[];
      window.renderStudentAssignments();
      toast(portalState.discovered.length?`${portalState.discovered.length} class${portalState.discovered.length===1?'':'es'} found`:'No class found',portalState.discovered.length?'success':'error');
    }catch(error){toast(messageText(error,'Could not find classes.'),'error')}
  };
  window.joinClass=window.findTeacherClasses;

  window.joinTeacherClass=async function(_teacherCode,classCode){
    const code=String(classCode||'').trim().toUpperCase();
    const keyInput=document.getElementById('joinKey_'+code);
    const class_key=String(keyInput?.value||'').trim();
    if(!code)return toast('Class code is missing','error');
    try{
      await request('/api/v1/classes/join',{
        method:'POST',
        body:JSON.stringify({code,class_key:class_key||null})
      });
      portalState.selectedStudentClass=code;
      portalState.discovered=[];
      await window.syncAcademicPortal(false,true);
      window.renderStudentAssignments();
      toast('Class joined successfully','success');
    }catch(error){toast(messageText(error,'Could not join class.'),'error')}
  };
  window.joinApprovedStudentClass=code=>window.joinTeacherClass('',code);

  window.leaveStudentClass=async function(code){
    const cls=classByCode(code);
    if(!cls||!classIdOf(cls))return toast('Class not found','error');
    if(!confirm('Leave this class?'))return;
    try{
      await request(`/api/v1/classes/${classIdOf(cls)}/leave`,{method:'POST'});
      portalState.selectedStudentClass='';
      await window.syncAcademicPortal(false,true);
      toast('Class left successfully','success');
    }catch(error){toast(messageText(error,'Could not leave class.'),'error')}
  };

  function discoveredClassCard(c){
    const code=classCodeOf(c),already=portalState.classes.some(x=>classCodeOf(x)===code);
    return `<article class="student-class-open-card">
      <div>
        <span class="class-kicker">${already?'Joined class':'Available class'}</span>
        <div class="class-title">${safe(c.className||'Academic Class')}</div>
        <div class="class-meta">
          <span class="badge brand">${safe(code)}</span>
          <span class="badge">${safe(c.subject||'General')}</span>
          <span class="badge">Section: ${safe(c.section||'—')}</span>
        </div>
        <p class="hint">Teacher: ${safe(c.teacherName||'Teacher')}</p>
      </div>
      ${already
        ?`<div class="notice">Already joined. Assignments from this class appear in Assessments.</div>`
        :`<div class="class-join-row"><input id="joinKey_${safe(code)}" class="input" placeholder="Enter class key"><button class="btn primary" type="button" onclick="joinTeacherClass('${safe(c.teacherCode||'')}','${safe(code)}')">Join class</button></div>`}
    </article>`;
  }

  function joinedClassCard(c,active){
    const code=classCodeOf(c),rows=assignmentsFor(code),isActive=code===active;
    return `<article class="student-class-open-card ${isActive?'active':''}">
      <div>
        <span class="class-kicker">Joined class</span>
        <div class="class-title">${safe(c.className||'Academic Class')}</div>
        <div class="class-meta">
          <span class="badge brand">${safe(code)}</span>
          <span class="badge">Teacher: ${safe(c.teacherName||'Teacher')}</span>
          <span class="badge">${rows.length} assignment${rows.length===1?'':'s'}</span>
        </div>
      </div>
      <div class="quick-actions">
        <button class="btn primary small" type="button" onclick="portalSelectStudentClass('${safe(code)}')">Open</button>
        <button class="btn danger small" type="button" onclick="leaveStudentClass('${safe(code)}')">Leave</button>
      </div>
    </article>`;
  }
  window.portalSelectStudentClass=async function(code){
    const selected=String(code||'').trim().toUpperCase();
    if(!selected)return toast('Class code is missing','error');
    portalState.selectedStudentClass=selected;
    state.activeStudentClassCode=selected;
    await window.syncAcademicPortal(true,true);
    window.renderStudentAssignments();
    showPanel('sAssignmentsPanel');
    setTimeout(()=>{
      document.getElementById('studentAssignmentsClassList')?.scrollIntoView({behavior:'smooth',block:'start'});
    },80);
  };

  function attemptsForAssignment(a){
    const id=assignmentIdOf(a);
    return portalState.myAttempts[String(id)]||[];
  }
  function latestSubmittedAttempt(a){
    return attemptsForAssignment(a).find(x=>String(x.status||'').toLowerCase()==='submitted')||null;
  }
  function studentAssignmentCard(a){
    const id=assignmentIdOf(a),submitted=latestSubmittedAttempt(a),pctValue=submitted&&submitted.total?Math.round(Number(submitted.score||0)/Math.max(1,Number(submitted.total||1))*100):0;
    return `<article class="assignment">
      <div>
        <span class="assignment-class-title">${safe(a.className||'Academic Class')} · ${safe(assignmentClassCode(a))}</span>
        <h3>${safe(a.title||'Untitled quiz')}</h3>
        <p>${safe(a.subject||'General')} · ${safe(a.count||0)} MCQs · Due ${safe(dateLabel(a.dueAt||a.due))}</p>
        <div class="assignment-pro-meta">
          <span class="badge brand">${a.timeLimitMinutes?`${safe(a.timeLimitMinutes)} min`:'No timer'}</span>
          <span class="badge ${a.allowRetake?'good':'warn'}">${a.allowRetake?'Retake allowed':'One attempt'}</span>
          ${submitted?`<span class="badge good">Submitted ${pctValue}%</span>`:'<span class="badge warn">Pending</span>'}
        </div>
      </div>
      <button class="btn primary" type="button" onclick="startAssignment(${id})">${submitted&&a.allowRetake?'Retake assignment':submitted?'View assignment':'Open assignment'}</button>
    </article>`;
  }

  window.renderStudentAssignments=function(){
    if(!SESSION||currentRole()!=='student')return;
    const joined=portalState.classes;
    const active=classCodeOf(activeStudentClass());
    const rows=active?assignmentsFor(active):[];
    const discovered=[...portalState.discovered].filter(c=>!joined.some(j=>classCodeOf(j)===classCodeOf(c)));

    setText('asClassCode',joined.length?`${joined.length} joined`:'0 joined');
    setText('asJoinedCount',joined.length?`${joined.length} joined`:'0 joined');
    setText('asTotal',portalState.assignments.length);
    setText('asQuestions',portalState.assignments.reduce((sum,a)=>sum+Number(a.count||0),0));
    setText('saClassCount',joined.length?`${joined.length} joined`:'0');
    setText('saAssignmentTotal',portalState.assignments.length);
    setText('saQuestionTotal',portalState.assignments.reduce((sum,a)=>sum+Number(a.count||0),0));
    const backendStudentCode=portalState.studentCode||'';
    setText('asStudentCode',backendStudentCode||'—');
    setText('asStudentAccessCode',backendStudentCode||'—');

    const current=document.getElementById('asCurrentClass');
    if(current)current.innerHTML=joined.length
      ?`Connected to <b>${joined.length} joined class${joined.length===1?'':'es'}</b>`
      :'No teacher class connected';

    const searchPicker=document.getElementById('asTeacherClassPicker');
    if(searchPicker){
      searchPicker.innerHTML=discovered.length
        ?discovered.map(discoveredClassCard).join('')
        :'<div class="assignment-empty-slim"><b>Search results appear here.</b><br>Enter a teacher code or class code above.</div>';
    }
    const joinedBoard=document.getElementById('asClassList');
    if(joinedBoard){
      joinedBoard.innerHTML=joined.length
        ?joined.map(c=>joinedClassCard(c,active)).join('')
        :'<div class="assignment-empty-slim"><b>No joined classes yet.</b><br>Find a class and join it to see it here.</div>';
    }
    const classList=document.getElementById('studentAssignmentsClassList');
    if(classList)classList.innerHTML=joined.length?joined.map(c=>joinedClassCard(c,active)).join(''):'<div class="assignment-empty-slim"><b>No joined class yet.</b></div>';

    const submittedRows=rows.flatMap(a=>attemptsForAssignment(a)
      .filter(x=>String(x.status||'').toLowerCase()==='submitted')
      .map(x=>({attempt:x,assignment:a})))
      .sort((a,b)=>new Date(b.attempt.submitted_at||0)-new Date(a.attempt.submitted_at||0));
    setText('studentAssignmentSubmittedBadge',`${submittedRows.length} submitted`);
    const submittedTitle=document.getElementById('studentSubmittedTitle');
    if(submittedTitle)submittedTitle.textContent=active?`${activeStudentClass()?.className||'Class'} submitted work`:'Submitted assessments';
    const submittedOut=document.getElementById('studentSubmittedAssignmentsOut');
    if(submittedOut)submittedOut.innerHTML=submittedRows.length?submittedRows.map(({attempt,assignment})=>{
      const total=Number(attempt.total||0),score=Number(attempt.score||0),percent=total?Math.round(score/total*100):0;
      return `<article class="submitted-assignment-card"><div><span>${safe(assignment.subject||'Submitted assessment')}</span><h3>${safe(assignment.title||'Untitled quiz')}</h3><p>${safe(attempt.submitted_at?new Date(attempt.submitted_at).toLocaleString():'Submitted')} · Attempt ${safe(attempt.attempt_no||1)} · ${score}/${total} correct</p></div><div class="submitted-score-pill">${percent}%</div></article>`;
    }).join(''):'<div class="assignment-empty-slim"><h3>No submitted assessments</h3><p>Completed assignments from the selected class will appear here.</p></div>';

    const out=document.getElementById('studentAssignmentsOut');
    if(out)out.innerHTML=!active
      ?'<div class="empty" style="min-height:220px"><div><h3>Join a class first</h3><p>Your teacher assignments will appear here.</p></div></div>'
      :rows.length?rows.map(studentAssignmentCard).join('')
      :'<div class="empty" style="min-height:220px"><div><h3>No assignments yet</h3><p>This class has no published assignments.</p></div></div>';
  };
  renderStudentAssignments=window.renderStudentAssignments;

  // -------- Secure assignment start/submit --------
  function assignmentAnswerMap(){
    const answers={};
    (state.quiz||[]).forEach((q,index)=>{
      if(state.answered[index]===undefined||state.answered[index]===null)return;
      const id=q.backendQuestionId||q.id;
      if(id!==undefined&&id!==null)answers[String(id)]=Number(state.answered[index]);
    });
    return answers;
  }

  window.startAssignment=async function(id){
    const a=portalState.assignments.find(x=>assignmentIdOf(x)===Number(id));
    if(!a)return toast('Assignment not found. Refresh the page.','error');
    try{
      const data=await request(`/api/v1/assignments/${Number(id)}/attempts/start`,{method:'POST'});
      const attempt=data?.attempt||{},questions=Array.isArray(data?.questions)?data.questions:[];
      if(!questions.length)throw new Error('This assignment has no questions.');
      state.assignmentAttemptId=attempt.attempt_id;
      state.activeAssignmentMeta={origin:'teacher',assignmentId:Number(id),assignmentTitle:a.title,title:a.title,classCode:assignmentClassCode(a),className:a.className,teacherName:a.teacherName,subject:a.subject,due:a.dueAt||a.due,instructions:a.instructions,count:questions.length};
      state.quiz=questions.map((q,i)=>normalizeQuestion({...q,id:q.id,backendQuestionId:q.id,question:q.question||q.question_body,correct:'',correct_index:null},i));
      state.answered={};
      const saved=attempt.answers||{};
      state.quiz.forEach((q,i)=>{const value=saved[String(q.backendQuestionId||q.id)];if(value!==undefined&&value!==null)state.answered[i]=Number(value)});
      state.submitted=false;state.lastResult=null;state.sessionId=null;
      if(document.getElementById('quizTitle'))document.getElementById('quizTitle').value=a.title||'Assigned quiz';
      showPanel('generatePanel');startTimer();renderQuiz();focusQuizMode(true);
      toast(attempt.attempt_no>1?`Retake ${attempt.attempt_no} started`:'Assignment started','success');
    }catch(error){toast(messageText(error,'Could not start assignment.'),'error')}
  };

  const oldSelect=window.selectAnswer||selectAnswer;
  window.selectAnswer=function(i,j){
    oldSelect(i,j);
    if(!state.assignmentAttemptId||state.submitted)return;
    clearTimeout(state.assignmentAutosaveTimer);
    state.assignmentAutosaveTimer=setTimeout(()=>{
      request(`/api/v1/assignment-attempts/${state.assignmentAttemptId}/answers`,{
        method:'PATCH',body:JSON.stringify({answers:assignmentAnswerMap()})
      }).catch(error=>console.warn('Autosave failed',error));
    },300);
  };
  selectAnswer=window.selectAnswer;

  const oldSubmit=window.submitQuiz||submitQuiz;
  window.submitQuiz=async function(){
    if(!state.assignmentAttemptId)return oldSubmit();
    if(!state.quiz.length)return;
    try{
      const response=await request(`/api/v1/assignment-attempts/${state.assignmentAttemptId}/submit`,{
        method:'POST',body:JSON.stringify({answers:assignmentAnswerMap()})
      });
      const result=response?.result||{};
      const review=Array.isArray(result.review)?result.review:[];
      const reviewMap=new Map(review.map(r=>[String(r.question_id),r]));
      state.quiz=state.quiz.map(q=>{
        const r=reviewMap.get(String(q.backendQuestionId||q.id));
        if(!r)return q;
        return {...q,correct_index:r.correct_index,correct:q.options?.[r.correct_index]||''};
      });
      const score=Number(result.score||0),total=Number(result.total||state.quiz.length);
      const answered=Number(result.answered??Object.keys(state.answered).length);
      const wrong=Number(result.wrong??Math.max(0,answered-score));
      const skipped=Number(result.skipped??Math.max(0,total-answered));
      const percent=Number(result.pct??Math.round(score/Math.max(1,total)*100));
      state.submitted=true;clearInterval(state.timer);
      state.lastResult={score,total,answered,wrong,skipped,pct:percent,title:state.activeAssignmentMeta?.title||'Assigned quiz',time:document.getElementById('timerBadge')?.textContent||'00:00',at:new Date().toLocaleString(),comparison:null};
      const scorePanel=document.getElementById('scorePanel');
      if(scorePanel){
        scorePanel.classList.add('show');
        scorePanel.innerHTML=`<div class="quiz-result-card"><div><div class="badge good">ASSIGNMENT SUBMITTED</div><h3 class="result-title">${safe(resultBand(percent))}</h3><div class="muted">${percent}% · ${score}/${total} correct · saved in database for teacher</div></div><div class="quick-actions"><button class="btn primary small" onclick="openStoredResultPop()">View result</button><button class="btn ghost small" onclick="showPanel('sAssignmentsPanel')">Back to assessments</button></div></div>`;
      }
      renderQuiz();
      state.assignmentAttemptId=null;
      await window.syncAcademicPortal(true,true);
      openStoredResultPop();
      toast('Assignment submitted to teacher','success');
    }catch(error){toast(messageText(error,'Could not submit assignment.'),'error')}
  };
  submitQuiz=window.submitQuiz;

  // -------- Teacher assignments and database progress --------
  function analyticsClass(code){
    const c=portalState.analytics?.classes?.find(x=>classCodeOf(x)===String(code||'').toUpperCase());
    return c||null;
  }
  function analyticsAssignment(id){
    for(const c of portalState.analytics?.classes||[]){
      const a=(c.assignments||[]).find(x=>Number(x.id||x.assignmentId)===Number(id));
      if(a)return a;
    }
    return null;
  }

  async function fetchTeacherAnalytics(){
    portalState.analytics=await request('/api/v1/analytics/teacher/overview');
    return portalState.analytics;
  }

  window.selectTeacherAssignmentClass=function(code){
    portalState.selectedTeacherClass=String(code||'').toUpperCase();
    state.activeTeacherAssignmentClassCode=portalState.selectedTeacherClass;
    window.renderTeacherAssignments();
    window.paintUser();
  };

  function teacherClassCard(c,activeCode){
    const code=classCodeOf(c),analytics=analyticsClass(code)||{},selected=code===activeCode;
    return `<article class="assignment-pro-class-card ${selected?'active':''}">
      <div>
        <span class="class-kicker">Teacher class</span>
        <div class="class-title">${safe(c.className||'Academic Class')}</div>
        <div class="class-meta"><span class="badge brand">${safe(code)}</span><span class="badge">${safe(c.subject||'General')}</span></div>
      </div>
      <div class="assignment-mini-stats">
        <div><span>Students</span><b>${safe(analytics.studentCount??c.members?.length??0)}</b></div>
        <div><span>Assessments</span><b>${safe(analytics.assignmentCount??assignmentsFor(code).length)}</b></div>
        <div><span>Submissions</span><b>${safe(analytics.submissionCount??0)}</b></div>
      </div>
      <button class="btn primary small" type="button" onclick="selectTeacherAssignmentClass('${safe(code)}')">${selected?'Open class':'Select'}</button>
    </article>`;
  }

  function teacherAssignmentCard(a){
    const id=assignmentIdOf(a),analytics=analyticsAssignment(id)?.analytics||{};
    return `<article class="assignment teacher-assignment-db-card">
      <div>
        <span class="assignment-class-title">${safe(a.className||'Academic Class')} · ${safe(assignmentClassCode(a))}</span>
        <h3>${safe(a.title||'Untitled quiz')}</h3>
        <p>${safe(a.subject||'General')} · ${safe(analytics.submitted||0)}/${safe(analytics.assigned||0)} submitted · avg ${safe(pct(analytics.average))}%</p>
        <div class="assignment-pro-meta">
          <span class="badge brand">Verified database</span>
          <span class="badge">${safe(pct(analytics.completionRate))}% complete</span>
          <span class="badge">${safe(analytics.pending||0)} pending</span>
          <span class="badge good">${safe(analytics.submitted||0)} submitted</span>
        </div>
      </div>
      <div class="quick-actions teacher-quiz-card-actions">
        <button class="btn ghost small" type="button" onclick="previewPortalQuiz(${id})">Preview</button>
        <button class="btn primary small" type="button" onclick="openInlineAssignmentResults(${id})">View results</button>
        <button class="btn danger small" type="button" onclick="deleteAssignment(${id})">Delete</button>
      </div>
    </article>`;
  }

  window.renderTeacherAssignments=async function(){
    if(!SESSION||currentRole()!=='teacher')return;
    const out=document.getElementById('teacherAssignmentsOut');
    const progress=document.getElementById('teacherAssignmentProgressOut');
    const classList=document.getElementById('teacherAssignmentClassList');
    try{
      if(!portalState.ready)await fetchPortalData();
      await fetchTeacherAnalytics();

      const selectedClass=activeTeacherClass();
      const selected=classCodeOf(selectedClass);
      const classAnalytics=analyticsClass(selected)||{};
      const rows=assignmentsFor(selected);

      setText('teacherAssignmentClassBadge',`${portalState.classes.length} class${portalState.classes.length===1?'':'es'}`);
      setText('teacherAssignmentListBadge',`${rows.length} assessment${rows.length===1?'':'s'}`);
      setText('teacherAssignmentWorkspaceTitle',selectedClass?`${selectedClass.className||'Selected class'} progress`:'Class progress');
      setText('teacherAssignmentWorkspaceHint',selectedClass?`${classAnalytics.studentCount??0} students · ${rows.length} assessments · ${classAnalytics.submissionCount??0} verified submissions`:'Select a class to view assessment progress.');

      if(classList){
        classList.innerHTML=portalState.classes.length
          ?portalState.classes.map(c=>teacherClassCard(c,selected)).join('')
          :'<div class="assignment-empty-slim"><h3>No class yet</h3><p>Create a class first.</p></div>';
      }

      if(!selectedClass){
        if(progress)progress.innerHTML='<div class="assignment-empty-slim"><h3>No selected class</h3><p>Select a class above.</p></div>';
        if(out)out.innerHTML='<div class="empty" style="min-height:220px"><div><h3>No assessments yet</h3><p>Create and publish an assignment.</p></div></div>';
        return;
      }

      if(progress){
        progress.innerHTML=`<div class="assignment-progress-summary">
          <div><span>Students</span><b>${safe(classAnalytics.studentCount??0)}</b></div>
          <div><span>Assessments</span><b>${safe(rows.length)}</b></div>
          <div><span>Submissions</span><b>${safe(classAnalytics.submissionCount??0)}</b></div>
          <div><span>Average</span><b>${safe(pct(classAnalytics.average))}%</b></div>
        </div>${rows.length?rows.map(a=>{
          const id=assignmentIdOf(a),an=analyticsAssignment(id)?.analytics||{};
          return `<article class="assignment-progress-row quiz-progress-card">
            <div class="quiz-progress-main">
              <span>${safe(a.sourceType||'Created quiz')} · ${safe(a.subject||selectedClass.subject||'General')}</span>
              <h3>${safe(a.title||'Untitled quiz')}</h3>
              <p>${safe(an.submitted||0)}/${safe(an.assigned||0)} students submitted · ${safe(an.pending||0)} pending · average ${safe(pct(an.average))}%</p>
              <div class="assignment-progress-bar"><div style="width:${Math.min(100,Math.max(0,Number(an.completionRate||0)))}%"></div></div>
            </div>
            <div class="quiz-progress-side">
              <div class="assignment-progress-pct">${safe(pct(an.completionRate))}%</div>
              <div class="quiz-progress-actions">
                <button class="btn ghost small" type="button" onclick="previewPortalQuiz(${id})">Preview</button>
                <button class="btn primary small" type="button" onclick="openInlineAssignmentResults(${id})">View results</button>
              </div>
            </div>
          </article>`;
        }).join(''):'<div class="assignment-empty-slim"><h3>No assessments yet</h3><p>Create an assessment for this class.</p></div>'}`;
      }

      if(out){
        out.innerHTML=rows.length
          ?rows.map(teacherAssignmentCard).join('')
          :'<div class="empty" style="min-height:220px"><div><h3>No assessments yet</h3><p>Create and publish an assignment for this class.</p></div></div>';
      }

      window.paintUser();
      if(portalState.openResultAssignmentId)await window.openInlineAssignmentResults(portalState.openResultAssignmentId,false);
    }catch(error){
      console.error('Teacher assignments render failed',error);
      if(progress)progress.innerHTML=`<div class="assignment-empty-slim"><h3>Progress could not load</h3><p>${safe(messageText(error))}</p></div>`;
      if(out)out.innerHTML=`<div class="assignment-empty-slim"><h3>Could not load assessments</h3><p>${safe(messageText(error))}</p><button class="btn primary small" onclick="renderTeacherAssignments()">Try again</button></div>`;
    }
  };
  renderTeacherAssignments=window.renderTeacherAssignments;

  function resultTable(report){
    const summary=report.summary||{},rows=Array.isArray(report.students)?report.students:[];
    return `<section id="teacherInlineResultSection" class="card card-pad teacher-inline-result-section">
      <div class="card-head">
        <div><span class="badge brand">Verified database report</span><h2 style="margin:12px 0 6px">${safe(report.assignment?.title||'Assignment results')}</h2><p class="muted">${safe(report.assignment?.className||'Class')} · ${safe(report.assignment?.subject||'General')}</p></div>
        <button class="btn ghost small" type="button" onclick="closeInlineAssignmentResults()">Close</button>
      </div>
      <div class="grid-4">
        <div class="kpi"><span>Assigned</span><b>${safe(summary.assigned||0)}</b></div>
        <div class="kpi"><span>Submitted</span><b>${safe(summary.submitted||0)}</b></div>
        <div class="kpi"><span>Completion</span><b>${safe(pct(summary.completionRate))}%</b></div>
        <div class="kpi"><span>Average</span><b>${safe(pct(summary.average))}%</b></div>
      </div>
      <div class="table-wrap" style="margin-top:18px"><table class="table"><thead><tr><th>Student</th><th>Code</th><th>Status</th><th>Attempt</th><th>Marks</th><th>Score</th><th>Correct</th><th>Wrong</th><th>Submitted</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td><b>${safe(r.studentName||'Student')}</b><br><small>${safe(r.studentEmail||'')}</small></td><td>${safe(r.studentCode||'—')}</td><td><span class="badge ${r.status==='submitted'?'good':'warn'}">${safe(r.status||'pending')}</span></td><td>${r.attemptNo??'—'}</td><td>${r.status==='submitted'?`${safe(r.score??0)}/${safe(r.total??0)}`:'—'}</td><td>${r.status==='submitted'?`${safe(pct(r.pct))}%`:'—'}</td><td>${r.correct??'—'}</td><td>${r.wrong??'—'}</td><td>${r.submittedAt?safe(analyticsDateLabel(r.submittedAt)):'—'}</td></tr>`).join('')||'<tr><td colspan="9">No students assigned.</td></tr>'}
      </tbody></table></div>
    </section>`;
  }

  window.openInlineAssignmentResults=async function(id,scroll=true){
    const assignmentId=Number(id);
    if(!Number.isFinite(assignmentId))return;
    portalState.openResultAssignmentId=assignmentId;
    const panel=document.getElementById('teacherAssignmentsPanel');
    let section=document.getElementById('teacherInlineResultSection');
    if(!section&&panel){
      panel.insertAdjacentHTML('beforeend','<section id="teacherInlineResultSection" class="card card-pad"><div class="assignment-empty-slim"><h3>Loading results…</h3></div></section>');
      section=document.getElementById('teacherInlineResultSection');
    }
    try{
      const report=await request(`/api/v1/analytics/assignments/${assignmentId}`);
      if(section)section.outerHTML=resultTable(report);
      if(scroll)setTimeout(()=>document.getElementById('teacherInlineResultSection')?.scrollIntoView({behavior:'smooth',block:'start'}),50);
    }catch(error){
      if(section)section.innerHTML=`<div class="assignment-empty-slim"><h3>Could not load results</h3><p>${safe(messageText(error))}</p></div>`;
      toast(messageText(error,'Could not load results.'),'error');
    }
  };
  window.closeInlineAssignmentResults=function(){
    portalState.openResultAssignmentId=null;
    document.getElementById('teacherInlineResultSection')?.remove();
  };

  // Rebind panel rendering so async authoritative screens are always refreshed.
  const previousRenderPanel=window.renderPanel||renderPanel;
  window.renderPanel=function(id){
    previousRenderPanel(id);
    if(id==='studentClassesPanel'||id==='sAssignmentsPanel'){
      window.syncAcademicPortal(true);
    }else if(id==='teacherAssignmentsPanel'){
      window.syncAcademicPortal(true);
    }else if(id==='teacherStudentsPanel'||id==='teacherDashboard'||id==='teacherQuizPanel'){
      window.syncAcademicPortal(true);
    }
  };
  renderPanel=window.renderPanel;


  // Stable backend-issued student reference code for teacher approval.
  window.studentAccessCode=function(){return portalState.studentCode||''};
  try{studentAccessCode=window.studentAccessCode}catch(_e){}

  // Initial authoritative refresh after the page has restored the session.
  function initialSync(){
    if(SESSION)setTimeout(()=>window.syncAcademicPortal(true),80);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialSync,{once:true});
  else initialSync();

  // Every visible Refresh action now performs a forced backend/database sync.
  async function runAuthoritativeRefresh(button){
    if(!SESSION)return;
    const old=button?.innerHTML;
    if(button){button.disabled=true;button.innerHTML='Refreshing...'}
    try{
      await window.syncAcademicPortal(false,true);
      const activePanel=document.querySelector('.panel.active')?.id||'';
      if(activePanel==='studentClassesPanel'||activePanel==='sAssignmentsPanel')window.renderStudentAssignments();
      if(activePanel==='teacherAssignmentsPanel')await window.renderTeacherAssignments();
      toast('Latest database data loaded','success');
    }finally{
      if(button){button.disabled=false;button.innerHTML=old}
    }
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button||button.dataset.portalRefreshBound==='1')return;
    const label=String(button.textContent||'').trim().toLowerCase();
    if(label==='refresh'||label.startsWith('refresh ')){
      button.dataset.portalRefreshBound='1';
      setTimeout(async()=>{
        try{await runAuthoritativeRefresh(button)}
        finally{delete button.dataset.portalRefreshBound}
      },0);
    }
  });

  // One-file layout correction for joined/search class boards.
  function installStudentClassLayout(){
    if(document.getElementById('aqg-student-class-layout-fix'))return;
    const style=document.createElement('style');
    style.id='aqg-student-class-layout-fix';
    style.textContent=`
      #asClassList,#studentAssignmentsClassList{
        display:grid!important;
        grid-template-columns:repeat(auto-fit,minmax(330px,1fr))!important;
        align-content:start!important;
        align-items:start!important;
        gap:14px!important;
        min-height:0!important;
      }
      #asClassList .student-class-open-card,
      #studentAssignmentsClassList .student-class-open-card{
        width:100%!important;
        min-width:0!important;
        min-height:138px!important;
        display:grid!important;
        grid-template-columns:minmax(0,1fr) auto!important;
        align-items:center!important;
        gap:18px!important;
        padding:20px!important;
        text-align:left!important;
      }
      #asClassList .class-title,
      #studentAssignmentsClassList .class-title{
        font-size:1.16rem!important;
        line-height:1.25!important;
        white-space:normal!important;
        overflow-wrap:anywhere!important;
      }
      #asClassList .class-meta,
      #studentAssignmentsClassList .class-meta{
        display:flex!important;
        flex-wrap:wrap!important;
        gap:8px!important;
        margin-top:10px!important;
      }
      #asClassList .quick-actions,
      #studentAssignmentsClassList .quick-actions{
        flex-wrap:nowrap!important;
        align-self:center!important;
      }
      #asTeacherClassPicker{
        display:grid!important;
        gap:12px!important;
        align-content:start!important;
      }
      @media(max-width:760px){
        #asClassList,#studentAssignmentsClassList{grid-template-columns:1fr!important}
        #asClassList .student-class-open-card,
        #studentAssignmentsClassList .student-class-open-card{grid-template-columns:1fr!important}
        #asClassList .quick-actions,
        #studentAssignmentsClassList .quick-actions{width:100%!important}
        #asClassList .quick-actions .btn,
        #studentAssignmentsClassList .quick-actions .btn{flex:1!important}
      }
    `;
    document.head.appendChild(style);
  }
  installStudentClassLayout();
})();
/* =====================================================================
   USER-FACING TERMINOLOGY PATCH
   Changes visible "Assignment/Assignments" wording to "Quiz/Quizzes".
   Internal function names, API paths, database fields and CSS classes remain
   unchanged so existing backend behavior cannot break.
   ===================================================================== */
(function installQuizTerminologyPatch(){
  function replaceTerminology(value){
    let text=String(value??'');

    text=text
      .replace(/\bAssignments\b/g,'Quizzes')
      .replace(/\bassignments\b/g,'quizzes')
      .replace(/\bASSIGNMENTS\b/g,'QUIZZES')
      .replace(/\bAssignment\b/g,'Quiz')
      .replace(/\bassignment\b/g,'quiz')
      .replace(/\bASSIGNMENT\b/g,'QUIZ')
      .replace(/\bAssessments\b/g,'Quizzes')
      .replace(/\bassessments\b/g,'quizzes')
      .replace(/\bASSESSMENTS\b/g,'QUIZZES')
      .replace(/\bAssessment\b/g,'Quiz')
      .replace(/\bassessment\b/g,'quiz')
      .replace(/\bASSESSMENT\b/g,'QUIZ');

    /* Prevent awkward duplicate phrases such as "Quiz quiz". */
    text=text
      .replace(/\bQuiz\s+quiz\b/g,'Quiz')
      .replace(/\bquiz\s+quiz\b/g,'quiz')
      .replace(/\bQuizzes\s+quizzes\b/g,'Quizzes')
      .replace(/\bquizzes\s+quizzes\b/g,'quizzes');

    return text;
  }

  function updateTextNode(node){
    if(!node||node.nodeType!==Node.TEXT_NODE)return;
    const parent=node.parentElement;
    if(!parent||['SCRIPT','STYLE','NOSCRIPT','CODE','PRE'].includes(parent.tagName))return;
    const next=replaceTerminology(node.nodeValue);
    if(next!==node.nodeValue)node.nodeValue=next;
  }

  function updateElementAttributes(element){
    if(!(element instanceof Element))return;
    ['title','placeholder','aria-label','data-tooltip'].forEach(function(name){
      if(!element.hasAttribute(name))return;
      const current=element.getAttribute(name);
      const next=replaceTerminology(current);
      if(next!==current)element.setAttribute(name,next);
    });
  }

  function updateTree(root){
    if(!root)return;
    if(root.nodeType===Node.TEXT_NODE){
      updateTextNode(root);
      return;
    }
    if(root.nodeType!==Node.ELEMENT_NODE&&root.nodeType!==Node.DOCUMENT_NODE&&root.nodeType!==Node.DOCUMENT_FRAGMENT_NODE)return;

    if(root.nodeType===Node.ELEMENT_NODE)updateElementAttributes(root);

    const walker=document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT
    );

    let node=walker.currentNode;
    while(node){
      if(node.nodeType===Node.TEXT_NODE)updateTextNode(node);
      else if(node.nodeType===Node.ELEMENT_NODE)updateElementAttributes(node);
      node=walker.nextNode();
    }
  }

  function applyEverywhere(){
    updateTree(document.body);
  }

  const observer=new MutationObserver(function(mutations){
    for(const mutation of mutations){
      if(mutation.type==='characterData'){
        updateTextNode(mutation.target);
        continue;
      }
      mutation.addedNodes.forEach(updateTree);
      if(mutation.type==='attributes')updateElementAttributes(mutation.target);
    }
  });

  function start(){
    applyEverywhere();
    observer.observe(document.body,{
      subtree:true,
      childList:true,
      characterData:true,
      attributes:true,
      attributeFilter:['title','placeholder','aria-label','data-tooltip']
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',start,{once:true});
  }else{
    start();
  }

  window.refreshQuizTerminology=applyEverywhere;
})();
