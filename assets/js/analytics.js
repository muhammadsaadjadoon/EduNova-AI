(function(){
  function placeStudentIdentity(){
    var panel=document.getElementById('studentClassesPanel');
    if(!panel)return;
    var box=document.getElementById('asStudentBox');
    var kpis=panel.querySelector('.assign-kpi-grid');
    if(!box||!kpis)return;
    var card=box.closest('.assign-card');
    if(!card)return;
    card.classList.add('student-identity-wide');
    kpis.insertAdjacentElement('afterend',card);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',placeStudentIdentity);
  else placeStudentIdentity();
})();


/* ===== TEACHER QUIZ POLICY CONTROLS ===== */
(function(){
  const originalStartTimer = window.startTimer;
  const originalResetAttempt = window.resetAttempt;
  const originalRenderQuiz = window.renderQuiz;
  const originalDirectStartAssignedQuiz = window.directStartAssignedQuiz;

  function currentTeacherQuizPolicy(){
    const meta = state.activeAssignmentMeta || state.currentSessionAssignmentMeta || {};
    return {
      timeLimitMinutes: Math.max(0, parseInt(meta.timeLimitMinutes || 0, 10) || 0),
      allowRetake: meta.allowRetake !== false
    };
  }

  function assignmentAttemptsFor(a, code){
    try{
      return studentAssignmentSubmissions(code, a.id) || [];
    }catch(e){
      return [];
    }
  }

  window.startTimer = function(){
    clearInterval(state.timer);
    state.startedAt = Date.now();
    const policy = currentTeacherQuizPolicy();

    if(!policy.timeLimitMinutes){
      return originalStartTimer();
    }

    const totalSeconds = policy.timeLimitMinutes * 60;
    const badge = document.querySelector('#timerBadge');

    function updateCountdown(){
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      const remain = Math.max(0, totalSeconds - elapsed);
      const mm = String(Math.floor(remain / 60)).padStart(2,'0');
      const ss = String(remain % 60).padStart(2,'0');
      if(badge){
        badge.textContent = mm + ':' + ss;
        badge.classList.toggle('warn', remain <= 60);
      }
      if(remain <= 0){
        clearInterval(state.timer);
        if(!state.submitted){
          toast('Time limit reached. Quiz submitted automatically.','error');
          submitQuiz();
        }
      }
    }

    updateCountdown();
    state.timer = setInterval(updateCountdown, 1000);
  };

  window.directStartAssignedQuiz = function(a, code, meta){
    const attempts = assignmentAttemptsFor(a, code);
    if(attempts.length && a.allowRetake === false){
      toast('This quiz allows one attempt only. Your result is already submitted.','error');
      showPanel('historyPanel');
      if(typeof loadHistory === 'function') loadHistory();
      return;
    }

    originalDirectStartAssignedQuiz(a, code, meta);
    if(state.activeAssignmentMeta){
      state.activeAssignmentMeta.timeLimitMinutes = Math.max(0, parseInt(a.timeLimitMinutes || 0,10) || 0);
      state.activeAssignmentMeta.allowRetake = a.allowRetake !== false;
      state.activeAssignmentMeta.attemptsBeforeStart = attempts.length;
    }
    startTimer();
  };

  window.resetAttempt = function(){
    const policy = currentTeacherQuizPolicy();
    if(state.activeAssignmentMeta && !policy.allowRetake && state.submitted){
      toast('Retake is disabled by the teacher for this quiz.','error');
      return;
    }
    return originalResetAttempt();
  };

  window.renderQuiz = function(){
    originalRenderQuiz();
    const policy = currentTeacherQuizPolicy();

    if(state.activeAssignmentMeta){
      const toolbar = document.querySelector('#quizBadges');
      if(toolbar){
        const policyText = policy.timeLimitMinutes
          ? policy.timeLimitMinutes + ' min limit'
          : 'No time limit';
        const retakeText = policy.allowRetake ? 'Retake allowed' : 'One attempt only';
        if(!toolbar.querySelector('[data-teacher-policy]')){
          toolbar.insertAdjacentHTML(
            'beforeend',
            '<span class="badge" data-teacher-policy>'+policyText+'</span>'+
            '<span class="badge '+(policy.allowRetake?'good':'warn')+'" data-teacher-policy>'+retakeText+'</span>'
          );
        }
      }

      if(!policy.allowRetake && state.submitted){
        document.querySelectorAll('#quizOut button').forEach(btn=>{
          if(/retake|reset answers/i.test(btn.textContent||'')){
            btn.remove();
          }
        });
      }
    }
  };

  const previousStartAssignment = window.startAssignment;
  window.startAssignment = function(id){
    const a = getStudentAssignments().find(x=>String(x.id)===String(id));
    if(a && assignmentIsDirectQuiz(a)){
      const code = a.joinedClassCode || a.classCode || '';
      const attempts = assignmentAttemptsFor(a, code);
      if(attempts.length && a.allowRetake === false){
        toast('This quiz is one-attempt only and has already been submitted.','error');
        showPanel('historyPanel');
        if(typeof loadHistory === 'function') loadHistory();
        return;
      }
    }
    return previousStartAssignment(id);
  };
})();



/* ===== TEACHER CLASSES: DEDICATED CLASS DETAIL VIEW ===== */
(function(){
  window.openTeacherClassDetail = function(code){
    state.openTeacherClassCode = String(code || '').toUpperCase();
    renderTeacherStudents();
    window.scrollTo({top:0, behavior:'smooth'});
  };

  window.closeTeacherClassDetail = function(){
    state.openTeacherClassCode = '';
    renderTeacherStudents();
    window.scrollTo({top:0, behavior:'smooth'});
  };

  window.renderTeacherStudents = function(){
    const out = $('#teacherStudentsOut');
    if(!out) return;

    const classes = ensureTeacherClasses();
    const tcode = teacherCode();
    const selectedCode = String(state.openTeacherClassCode || '').toUpperCase();
    const selectedClass = classes.find(c => String(c.code || '').toUpperCase() === selectedCode);

    if(selectedClass){
      const code = String(selectedClass.code || '').toUpperCase();
      const students = readJSON(studentsKey(code), []);
      const assessments = readJSON(classAssignmentsKey(code), []);
      const allowed = [...(selectedClass.allowedStudents || []), ...(selectedClass.allowedEmails || [])];

      const approvedRows = allowed.length
        ? allowed.map(v => `
            <div class="teacher-class-detail-row">
              <div>
                <span>Approved access key</span>
                <b>${safe(v)}</b>
                <small>Teacher-approved direct access.</small>
              </div>
              <button class="btn danger small" onclick="removeAllowedStudent('${safe(code)}','${safe(v)}');openTeacherClassDetail('${safe(code)}')">Remove</button>
            </div>
          `).join('')
        : `<div class="teacher-class-detail-empty">No approved student keys yet.</div>`;

      const studentRows = students.length
        ? students.map(s => `
            <div class="teacher-class-detail-row student">
              <div>
                <span>Joined student</span>
                <b>${safe(s.fullName || s.username || 'Student')}</b>
                <small>${safe(s.studentCode || 'No student code')}${s.email ? ' · ' + safe(s.email) : ''}</small>
              </div>
              <span class="badge good">Joined</span>
            </div>
          `).join('')
        : `<div class="teacher-class-detail-empty">No students have joined this class yet.</div>`;

      out.innerHTML = `
        <div class="teacher-class-detail-page">
          <div class="teacher-class-detail-nav">
            <button class="btn ghost small" onclick="closeTeacherClassDetail()">← Back to classes</button>
            <span class="badge brand">Class workspace</span>
          </div>

          <section class="teacher-class-detail-hero">
            <div>
              <span class="class-kicker">Teacher class</span>
              <h1>${safe(selectedClass.className || 'Academic Class')}</h1>
              <div class="teacher-room-meta">
                <span class="badge brand">${safe(code)}</span>
                <span class="badge">${safe(selectedClass.subject || 'General')}</span>
                <span class="badge">Key: ${safe(selectedClass.classKey || '-')}</span>
              </div>
            </div>
            <button class="btn ${code===activeTeacherClassCode()?'good':'primary'}" onclick="setActiveTeacherClass('${safe(code)}');openTeacherClassDetail('${safe(code)}')">
              ${code===activeTeacherClassCode()?'Active class':'Make active'}
            </button>
          </section>

          <div class="teacher-class-detail-stats">
            <div><span>Students</span><b>${students.length}</b></div>
            <div><span>Assessments</span><b>${assessments.length}</b></div>
            <div><span>Approved keys</span><b>${allowed.length}</b></div>
          </div>

          <section class="teacher-class-detail-panel">
            <div class="teacher-class-detail-heading">
              <div>
                <h2>Student access</h2>
                <p>Approve a student code or email before they join this class.</p>
              </div>
            </div>
            <div class="teacher-class-detail-approve">
              <input id="allow_${safe(code)}" class="input" placeholder="Student key/code or email">
              <button class="btn primary" onclick="addAllowedStudents('${safe(code)}');openTeacherClassDetail('${safe(code)}')">Approve student</button>
            </div>
          </section>

          <div class="teacher-class-detail-columns">
            <section class="teacher-class-detail-panel">
              <div class="teacher-class-detail-heading">
                <div>
                  <h2>Joined students</h2>
                  <p>Students currently enrolled in this class.</p>
                </div>
                <span class="badge">${students.length}</span>
              </div>
              <div class="teacher-class-detail-list">${studentRows}</div>
            </section>

            <section class="teacher-class-detail-panel">
              <div class="teacher-class-detail-heading">
                <div>
                  <h2>Approved access</h2>
                  <p>Student keys or emails approved for direct joining.</p>
                </div>
                <span class="badge">${allowed.length}</span>
              </div>
              <div class="teacher-class-detail-list">${approvedRows}</div>
            </section>
          </div>

          <section class="teacher-class-detail-panel">
            <div class="teacher-class-detail-heading">
              <div>
                <h2>Class actions</h2>
                <p>Copy access details or permanently remove this class.</p>
              </div>
            </div>
            <div class="teacher-class-detail-actions">
              <button class="btn ghost" onclick="navigator.clipboard?.writeText('${safe(tcode)}');toast('Teacher code copied','success')">Copy teacher code</button>
              <button class="btn ghost" onclick="navigator.clipboard?.writeText('${safe(code)}');toast('Class code copied','success')">Copy class code</button>
              <button class="btn ghost" onclick="navigator.clipboard?.writeText('${safe(selectedClass.classKey || '')}');toast('Class key copied','success')">Copy class key</button>
              <button class="btn danger" onclick="deleteTeacherClass('${safe(code)}');closeTeacherClassDetail()">Delete class</button>
            </div>
          </section>
        </div>
      `;
      return;
    }

    const totalStudents = classes.reduce((n,c) => n + readJSON(studentsKey(c.code), []).length, 0);
    const totalAssessments = classes.reduce((n,c) => n + readJSON(classAssignmentsKey(c.code), []).length, 0);

    const cards = classes.map(c => {
      const code = String(c.code || '').toUpperCase();
      const students = readJSON(studentsKey(code), []);
      const assessments = readJSON(classAssignmentsKey(code), []);
      const allowed = [...(c.allowedStudents || []), ...(c.allowedEmails || [])];
      const active = code === activeTeacherClassCode();

      return `
        <article class="teacher-class-summary-card ${active?'active':''}">
          <div class="teacher-class-summary-top">
            <div>
              <span class="class-kicker">${active?'Active class':'Teacher class'}</span>
              <h3>${safe(c.className || 'Academic Class')}</h3>
              <div class="teacher-room-meta">
                <span class="badge brand">${safe(code)}</span>
                <span class="badge">${safe(c.subject || 'General')}</span>
                <span class="badge">Key: ${safe(c.classKey || '-')}</span>
              </div>
            </div>
            ${active?'<span class="badge good">Active</span>':''}
          </div>

          <div class="teacher-class-summary-stats">
            <div><span>Students</span><b>${students.length}</b></div>
            <div><span>Assessments</span><b>${assessments.length}</b></div>
            <div><span>Approved</span><b>${allowed.length}</b></div>
          </div>

          <div class="teacher-class-summary-actions">
            <button class="btn primary" onclick="openTeacherClassDetail('${safe(code)}')">Open class</button>
            ${active?'':`<button class="btn ghost" onclick="setActiveTeacherClass('${safe(code)}');renderTeacherStudents()">Make active</button>`}
          </div>
        </article>
      `;
    }).join('');

    out.innerHTML = `
      <div class="teacher-class-admin classes-shell">
        <div class="teacher-class-summary">
          <div><span>Teacher invite code</span><b class="mono">${safe(tcode)}</b></div>
          <div><span>Total classes</span><b>${classes.length}</b></div>
          <div><span>Enrolled students</span><b>${totalStudents}</b></div>
          <div><span>Assessments</span><b>${totalAssessments}</b></div>
        </div>

        <section class="classes-surface teacher-create-block">
          <div class="teacher-block-head">
            <div>
              <h2>Create a class</h2>
              <p>Add the basic academic details. Class code and secure access are created automatically.</p>
            </div>
            <span class="badge brand">New class</span>
          </div>
          <div class="teacher-class-form">
            <div class="form-group"><label class="label">Class name</label><input id="tcName" class="input" placeholder="BS AI Semester 2"></div>
            <div class="form-group"><label class="label">Subject</label><input id="tcSubject" class="input" placeholder="Machine Learning"></div>
            <div class="form-group"><label class="label">Section</label><input id="tcSection" class="input" placeholder="A / Morning"></div>
            <div class="form-group"><label class="label">Class key</label><input id="tcKey" class="input" placeholder="Auto"></div>
            <button class="btn primary" onclick="createTeacherClass()">Create class</button>
          </div>
        </section>

        <section class="classes-surface teacher-rooms-block">
          <div class="teacher-rooms-heading">
            <div>
              <h2>Your classes</h2>
              <p>Open a class to view students, approvals and class access details.</p>
            </div>
            <span class="badge">${classes.length} class${classes.length===1?'':'es'}</span>
          </div>
          <div class="teacher-class-summary-grid">
            ${cards || '<div class="assignment-empty-slim"><h3>No classes yet</h3><p>Create your first class above.</p></div>'}
          </div>
        </section>
      </div>
    `;
  };
})();


/* ===== Phase 2: secure server-backed classes compatibility layer ===== */
let PHASE2_CLASS_SYNCING=false;
function phase2CacheClasses(payload){
  const classes=Array.isArray(payload?.classes)?payload.classes:[];
  if(getRole()==='teacher'){
    writeJSON(teacherClassesKey(),classes);
    const d={...profileDetails(),teacherAccessCode:payload.teacherCode||classes[0]?.teacherCode||profileDetails().teacherAccessCode||'',activeClassCode:classes.some(c=>c.code===profileDetails().activeClassCode)?profileDetails().activeClassCode:(classes[0]?.code||'')};
    writeJSON(profileKey(),d);
    classes.forEach(c=>writeJSON(studentsKey(c.code),Array.isArray(c.members)?c.members:[]));
    publishTeacherDirectory(classes);
  }else{
    saveStudentJoinedCodes(classes.map(c=>c.code));
    classes.forEach(c=>{
      const dir=readJSON(classDirectoryKey(),{});dir[c.code]=c;writeJSON(classDirectoryKey(),dir);
    });
  }
  return classes;
}
async function syncClassesFromServer(render=false){
  if(!SESSION||PHASE2_CLASS_SYNCING)return [];
  PHASE2_CLASS_SYNCING=true;
  try{
    const data=await request('/api/v1/classes/mine');
    const rows=phase2CacheClasses(data);
    if(render){paintUser();if(getRole()==='teacher'){renderTeacherStudents();renderTeacherDashboard();renderTeacherClassSelect()}else{renderStudentAssignments();renderStudentDashboard()}}
    return rows;
  }catch(e){console.warn('Class sync failed',e);return []}finally{PHASE2_CLASS_SYNCING=false}
}
function ensureTeacherClasses(){if(!SESSION||getRole()!=='teacher')return [];const arr=readJSON(teacherClassesKey(),[]);return Array.isArray(arr)?arr:[]}
function teacherCode(){const d=profileDetails(),arr=ensureTeacherClasses();return String(d.teacherAccessCode||arr[0]?.teacherCode||'Not generated').toUpperCase()}
async function createTeacherClass(){
  const d=profileDetails(),name=($('#tcName')?.value||'').trim(),subject=($('#tcSubject')?.value||d.teacherSubject||'General').trim(),section=($('#tcSection')?.value||'').trim(),key=($('#tcKey')?.value||'').trim().toUpperCase();
  if(!name)return toast('Enter class name','error');
  try{
    const c=await request('/api/v1/classes',{method:'POST',body:JSON.stringify({name,subject,section,class_key:key||null})});
    await syncClassesFromServer();writeJSON(profileKey(),{...profileDetails(),activeClassCode:c.code});
    ['#tcName','#tcSubject','#tcSection','#tcKey'].forEach(id=>{const el=$(id);if(el)el.value=''});
    renderTeacherStudents();renderTeacherDashboard();renderTeacherClassSelect();toast('Class created: '+c.className,'success');
  }catch(e){toast(e.message,'error')}
}
async function deleteTeacherClass(code){
  const c=ensureTeacherClasses().find(x=>String(x.code).toUpperCase()===String(code).toUpperCase());if(!c)return;
  if(!confirm('Delete this class? Students will lose access, while existing quiz history remains safe.'))return;
  try{await request('/api/v1/classes/'+c.id,{method:'DELETE'});await syncClassesFromServer();renderTeacherStudents();renderTeacherDashboard();renderTeacherClassSelect();toast('Class removed','success')}catch(e){toast(e.message,'error')}
}
async function addAllowedStudents(code){
  const c=ensureTeacherClasses().find(x=>String(x.code).toUpperCase()===String(code).toUpperCase()),inp=$('#allow_'+String(code).toUpperCase()),raw=(inp?.value||'').trim();
  if(!c||!raw)return toast('Add student codes or emails','error');
  try{for(const value of raw.split(/[\s,;]+/).filter(Boolean))await request(`/api/v1/classes/${c.id}/approvals`,{method:'POST',body:JSON.stringify({value})});if(inp)inp.value='';await syncClassesFromServer();renderTeacherStudents();toast('Student approved for this class','success')}catch(e){toast(e.message,'error')}
}
async function removeAllowedStudent(code,val){
  const c=ensureTeacherClasses().find(x=>String(x.code).toUpperCase()===String(code).toUpperCase());if(!c)return;
  try{await request(`/api/v1/classes/${c.id}/approvals/${encodeURIComponent(val)}`,{method:'DELETE'});await syncClassesFromServer();renderTeacherStudents();toast('Student approval removed','success')}catch(e){toast(e.message,'error')}
}
async function removeClassStudent(code,userId){
  const c=ensureTeacherClasses().find(x=>String(x.code).toUpperCase()===String(code).toUpperCase());if(!c)return;
  if(!confirm('Remove this student from the class?'))return;
  try{await request(`/api/v1/classes/${c.id}/members/${userId}`,{method:'DELETE'});await syncClassesFromServer();renderTeacherStudents();renderTeacherDashboard();toast('Student removed from class','success')}catch(e){toast(e.message,'error')}
}
async function findTeacherClasses(){
  const input=$('#joinClassCode'),code=String(input?.value||'').trim().toUpperCase();if(!code)return toast('Enter teacher code or class code','error');
  try{
    const data=await request('/api/v1/classes/discover/'+encodeURIComponent(code)),rows=data.classes||[];
    if(!rows.length)return toast('No active class found for this code','error');
    const t=rows[0],teacher={teacherCode:t.teacherCode,teacherName:t.teacherName,teacherEmail:t.teacherEmail,classes:rows};
    const tdir=readJSON(teacherMasterDirectoryKey(),{}),dir=readJSON(classDirectoryKey(),{});tdir[t.teacherCode]=teacher;rows.forEach(c=>dir[c.code]=c);writeJSON(teacherMasterDirectoryKey(),tdir);writeJSON(classDirectoryKey(),dir);
    state.joinTeacherCode=t.teacherCode;state.joinClassFilterCode=code.startsWith('CLS-')?code:'';renderStudentTeacherClasses(teacher,state.joinClassFilterCode);
  }catch(e){toast(e.message,'error')}
}
function joinClass(){findTeacherClasses()}
async function joinTeacherClass(teacherInvite,classCode){
  classCode=String(classCode||'').toUpperCase();const key=String($('#joinKey_'+classCode)?.value||'').trim().toUpperCase();
  try{const c=await request('/api/v1/classes/join',{method:'POST',body:JSON.stringify({code:classCode,class_key:key||null})});await syncClassesFromServer();state.activeStudentClassCode=classCode;paintUser();renderStudentAssignments();renderStudentDashboard();const teacher=teacherByInvite(c.teacherCode)||{teacherCode:c.teacherCode,teacherName:c.teacherName,classes:[c]};renderStudentTeacherClasses(teacher,state.joinClassFilterCode||'');toast('Joined '+c.className,'success')}catch(e){toast(e.message,'error')}
}
async function leaveStudentClass(code){
  code=String(code||'').toUpperCase();const c=(await syncClassesFromServer()).find(x=>x.code===code)||classDirectoryRecord(code);if(!c)return;
  if(!confirm('Leave class '+code+'?'))return;
  try{await request(`/api/v1/classes/${c.id}/leave`,{method:'POST'});await syncClassesFromServer();paintUser();renderStudentAssignments();renderStudentDashboard();toast('Class removed','success')}catch(e){toast(e.message,'error')}
}
const _phase2RenderPanel=renderPanel;
renderPanel=function(id){_phase2RenderPanel(id);if(['teacherDashboard','teacherStudentsPanel','teacherQuizPanel','teacherAssignmentsPanel','teacherAnalyticsPanel','studentDashboard','studentClassesPanel','sAssignmentsPanel'].includes(id))syncClassesFromServer(true)};
setTimeout(()=>{if(SESSION)syncClassesFromServer(true)},250);

/* ═══════════════════════════════════════════════════════════════
   PHASE 3 — DATABASE-BACKED ASSIGNMENTS
   Existing UI remains intact; localStorage is now only a render cache.
═══════════════════════════════════════════════════════════════ */
let PHASE3_ASSIGNMENT_SYNCING=false;
function phase3CacheAssignments(rows){
  rows=Array.isArray(rows)?rows:[];
  if(getRole()==='teacher')writeJSON(assignmentsKey(),rows);
  const byClass={};
  rows.forEach(a=>{const code=String(a.classCode||'').toUpperCase();if(!code)return;(byClass[code]||(byClass[code]=[])).push(a)});
  const classCodes=new Set([...studentJoinedCodes(),...ensureTeacherClasses().map(c=>String(c.code||'').toUpperCase()),...Object.keys(byClass)]);
  classCodes.forEach(code=>writeJSON(classAssignmentsKey(code),byClass[code]||[]));
  return rows;
}
async function syncAssignmentsFromServer(render=false){
  if(!SESSION||PHASE3_ASSIGNMENT_SYNCING)return [];
  PHASE3_ASSIGNMENT_SYNCING=true;
  try{
    const data=await request('/api/v1/assignments/mine');
    const rows=phase3CacheAssignments(data?.assignments||[]);
    if(render){
      if(getRole()==='teacher'){
        _phase3LegacyRenderTeacherAssignments();renderTeacherDashboard();
      }else{
        _phase3LegacyRenderStudentAssignments();renderStudentDashboard();
      }
    }
    return rows;
  }catch(e){console.warn('Assignment sync failed',e);return []}
  finally{PHASE3_ASSIGNMENT_SYNCING=false}
}
function phase3AssignmentSource(){
  const mode=teacherAssignmentMode();
  if(mode==='direct')return ($('#taDirectMcqs')?.value||'').trim();
  if(mode==='mcq_pdf')return ($('#taMcqPdfText')?.value||'').trim();
  if(mode==='study_pdf')return ($('#taStudyText')?.value||'').trim();
  return ($('#taContent')?.value||'').trim();
}
const _phase3LegacyCreateAssignment=createAssignment;
async function createAssignment(){
  const before=new Set(readJSON(assignmentsKey(),[]).map(a=>String(a.id)));
  await _phase3LegacyCreateAssignment();
  const localRows=readJSON(assignmentsKey(),[]),a=[...localRows].reverse().find(x=>!before.has(String(x.id)));
  if(!a)return;
  const cls=ensureTeacherClasses().find(c=>String(c.code).toUpperCase()===String(a.classCode).toUpperCase());
  if(!cls||!cls.id){toast('Assignment created locally, but class database sync is unavailable.','error');return}
  try{
    const payload={class_id:Number(cls.id),title:a.title,subject:a.subject||cls.subject||'General',instructions:a.instructions||'',source_type:a.assignmentType||a.sourceKind||'create',source_content:a.content||'',question_count:Number(a.count||a.quiz?.length||10),time_limit_minutes:Number(a.timeLimitMinutes||0),allow_retake:a.allowRetake!==false,status:'published',due_at:a.due?new Date(a.due+'T23:59:59').toISOString():null,target_student_ids:[],questions:Array.isArray(a.quiz)?a.quiz:[]};
    const saved=await request('/api/v1/assignments',{method:'POST',body:JSON.stringify(payload)});
    // Remove temporary browser-only record; authoritative database record is cached next.
    writeJSON(assignmentsKey(),localRows.filter(x=>String(x.id)!==String(a.id)));
    writeJSON(classAssignmentsKey(a.classCode),readJSON(classAssignmentsKey(a.classCode),[]).filter(x=>String(x.id)!==String(a.id)));
    await syncAssignmentsFromServer(false);_phase3LegacyRenderTeacherAssignments();renderTeacherDashboard();
    toast('Assignment securely saved to database','success');
  }catch(e){toast('Assignment backend save failed: '+e.message,'error')}
}
async function deleteAssignment(id){
  if(!confirm('Delete this assignment permanently?'))return;
  try{await request('/api/v1/assignments/'+id,{method:'DELETE'});await syncAssignmentsFromServer(false);_phase3LegacyRenderTeacherAssignments();renderTeacherDashboard();toast('Assignment deleted','success')}catch(e){toast(e.message,'error')}
}
async function phase3SetAssignmentStatus(id,status){
  try{await request(`/api/v1/assignments/${id}/${status==='closed'?'close':'publish'}`,{method:'POST'});await syncAssignmentsFromServer(true);toast(status==='closed'?'Assignment closed':'Assignment published','success')}catch(e){toast(e.message,'error')}
}
const _phase3LegacyRenderTeacherAssignments=renderTeacherAssignments;
const _phase3LegacyRenderStudentAssignments=renderStudentAssignments;
renderTeacherAssignments=function(){_phase3LegacyRenderTeacherAssignments();syncAssignmentsFromServer(false).then(()=>_phase3LegacyRenderTeacherAssignments())};
renderStudentAssignments=function(){_phase3LegacyRenderStudentAssignments();syncAssignmentsFromServer(false).then(()=>_phase3LegacyRenderStudentAssignments())};
const _phase3RenderPanel=renderPanel;
renderPanel=function(id){_phase3RenderPanel(id);if(['teacherDashboard','teacherAssignmentsPanel','teacherAnalyticsPanel','studentDashboard','studentClassesPanel','sAssignmentsPanel'].includes(id))syncAssignmentsFromServer(true)};
setTimeout(()=>{if(SESSION)syncAssignmentsFromServer(true)},500);



/* ═══════════════════════════════════════════════════════════════
   PHASE 4 — SECURE ASSIGNMENT ATTEMPTS
   Server-authoritative timer, autosave, resume and grading.
═══════════════════════════════════════════════════════════════ */
let PHASE4_ATTEMPT=null,PHASE4_SAVE_TIMER=null,PHASE4_CLOCK=null,PHASE4_SUBMITTING=false;
function phase4AnswerPayload(){const out={};(state.quiz||[]).forEach((q,i)=>{if(state.answered[i]!==undefined)out[String(q.id)]=Number(state.answered[i])});return out}
function phase4ApplySavedAnswers(saved={}){state.answered={};(state.quiz||[]).forEach((q,i)=>{if(saved[String(q.id)]!==undefined)state.answered[i]=Number(saved[String(q.id)])})}
function phase4StopClock(){if(PHASE4_CLOCK){clearInterval(PHASE4_CLOCK);PHASE4_CLOCK=null}}
function phase4PaintClock(){if(!PHASE4_ATTEMPT?.expires_at)return;const left=Math.max(0,Math.floor((new Date(PHASE4_ATTEMPT.expires_at).getTime()-Date.now())/1000)),m=String(Math.floor(left/60)).padStart(2,'0'),sec=String(left%60).padStart(2,'0');const el=$('#timerBadge');if(el)el.textContent=m+':'+sec;if(left<=0){phase4StopClock();if(!state.submitted)phase4SubmitAssignment(true)}}
function phase4StartClock(){phase4StopClock();if(PHASE4_ATTEMPT?.expires_at){phase4PaintClock();PHASE4_CLOCK=setInterval(phase4PaintClock,1000)}else startTimer()}
async function phase4Autosave(){if(!PHASE4_ATTEMPT?.attempt_id||state.submitted)return;try{const d=await request('/api/v1/assignment-attempts/'+PHASE4_ATTEMPT.attempt_id+'/answers',{method:'PATCH',body:JSON.stringify({answers:phase4AnswerPayload()})});if(d.expired)await phase4HandleResult(d.result,true)}catch(e){console.warn('Assignment autosave failed',e)}}
function phase4QueueAutosave(){clearTimeout(PHASE4_SAVE_TIMER);PHASE4_SAVE_TIMER=setTimeout(phase4Autosave,500)}
async function phase4OpenAssignment(id){
  try{
    const d=await request('/api/v1/assignments/'+id+'/attempts/start',{method:'POST'});const a=d.assignment||{},attempt=d.attempt||{};
    if(!Array.isArray(d.questions)||!d.questions.length)return toast('This assignment has no quiz questions yet.','error');
    PHASE4_ATTEMPT=attempt;state.currentSessionAssignmentMeta=null;state.activeAssignmentMeta={origin:'teacher',assignmentId:a.id||id,assignmentTitle:a.title,title:a.title,classCode:a.classCode,className:a.className,teacherName:a.teacherName,teacherCode:a.teacherCode||'',subject:a.subject||'General',due:a.due||'',instructions:a.instructions||'',count:d.questions.length,assignmentType:a.assignmentType||a.source_type||''};
    state.quiz=d.questions.map((q,i)=>normalizeQuestion({...q,correct:null},i));state.quiz.forEach(q=>{delete q.correct});phase4ApplySavedAnswers(attempt.answers||{});state.submitted=false;state.lastResult=null;state.sessionId=null;state.filter='all';state.mcqPrompted=false;state.startedAt=new Date(attempt.started_at||Date.now()).getTime();
    $('#scorePanel')?.classList.remove('show');if($('#quizTitle'))$('#quizTitle').value=a.title||'Assigned quiz';if($('#customCount'))$('#customCount').value=state.quiz.length;
    showPanel('generatePanel');renderQuiz();focusQuizMode(true);phase4StartClock();toast(attempt.answered_count?'Attempt resumed with saved answers':'Secure assignment attempt started','success');
  }catch(e){toast(e.message||'Could not start assignment','error')}
}
async function phase4HandleResult(r,expired=false){
  if(!r)return;phase4StopClock();state.submitted=true;
  (r.review||[]).forEach(item=>{const i=(state.quiz||[]).findIndex(q=>String(q.id)===String(item.question_id));if(i>=0){state.quiz[i].correct_index=item.correct_index;state.quiz[i].correct=state.quiz[i].options[item.correct_index]}});
  const score=Number(r.score||0),total=Number(r.total||state.quiz.length),answered=Number(r.answered||0),wrong=Number(r.wrong||0),skipped=Number(r.skipped||0),pct=Number(r.pct||0),title=$('#quizTitle')?.value?.trim()||'Assigned quiz',time=$('#timerBadge')?.textContent||'00:00',at=new Date().toLocaleString();
  state.lastResult={score,total,answered,wrong,skipped,pct,title,time,at,comparison:null};$('#scorePanel')?.classList.add('show');$('#scorePanel').innerHTML=`<div class="quiz-result-card"><div><div class="badge ${expired?'warn':'good'}">${expired?'TIME EXPIRED':'SECURE RESULT'}</div><h3 class="result-title">${safe(resultBand(pct))}</h3><div class="muted">Server verified · ${pct}% · ${score}/${total} correct · ${answered} answered</div></div><div class="quick-actions"><button class="btn primary small" onclick="openStoredResultPop()">View Result Card</button><button class="btn ghost small" onclick="showPanel('sAssignmentsPanel')">Back to assignments</button></div></div>`;
  renderQuiz();storeLocalAttempt(score,total,pct,null);saveAutoWeakQuiz(score,total,pct,answered,wrong,skipped,title,time,at);renderStudentDashboard();renderStats();renderRevision();syncAssignmentsFromServer(true);openStoredResultPop();PHASE4_ATTEMPT=null;
}
async function phase4SubmitAssignment(expired=false){if(!PHASE4_ATTEMPT?.attempt_id||PHASE4_SUBMITTING)return;PHASE4_SUBMITTING=true;try{await phase4Autosave();const d=await request('/api/v1/assignment-attempts/'+PHASE4_ATTEMPT.attempt_id+'/submit',{method:'POST',body:JSON.stringify({answers:phase4AnswerPayload()})});if(d.already_submitted){toast('This attempt was already submitted.','error');return}await phase4HandleResult(d.result,expired)}catch(e){toast(e.message||'Submission failed','error')}finally{PHASE4_SUBMITTING=false}}
const _phase4LegacyStartAssignment=startAssignment;startAssignment=function(id){const a=getStudentAssignments().find(x=>String(x.id)===String(id));if(a&&assignmentIsDirectQuiz(a))return phase4OpenAssignment(id);return _phase4LegacyStartAssignment(id)};
const _phase4LegacySelectAnswer=selectAnswer;selectAnswer=function(i,j){_phase4LegacySelectAnswer(i,j);if(PHASE4_ATTEMPT)phase4QueueAutosave()};
const _phase4LegacySubmitQuiz=submitQuiz;submitQuiz=async function(){if(PHASE4_ATTEMPT)return phase4SubmitAssignment(false);return _phase4LegacySubmitQuiz()};
const _phase4LegacyResetAttempt=resetAttempt;resetAttempt=function(){if(PHASE4_ATTEMPT){toast('Use the assignment page to start a permitted retake after submission.','error');return}return _phase4LegacyResetAttempt()};
window.addEventListener('beforeunload',()=>{if(PHASE4_ATTEMPT&&!state.submitted){try{navigator.sendBeacon&&phase4Autosave()}catch(e){}}});


/* ═══════════════════════════════════════════════════════════════
   PHASE 5 — PROFESSIONAL DATABASE ANALYTICS
   Authoritative reports use secure backend submissions only.
═══════════════════════════════════════════════════════════════ */
let PHASE5_OVERVIEW=null,PHASE5_ACTIVE_CLASS='',PHASE5_ACTIVE_ASSIGNMENT='',PHASE5_ASSIGNMENT_REPORT=null,PHASE5_LOADING=false,PHASE5_FILTER='';
function p5Num(v,d=0){v=Number(v);return Number.isFinite(v)?v:d}
function p5Pct(v){return Math.round(p5Num(v)*10)/10}
function p5Date(v){if(!v)return '—';try{return new Date(v).toLocaleString()}catch{return '—'}}
async function phase5LoadOverview(force=false){
  if(PHASE5_LOADING)return PHASE5_OVERVIEW;
  if(PHASE5_OVERVIEW&&!force)return PHASE5_OVERVIEW;
  PHASE5_LOADING=true;
  try{PHASE5_OVERVIEW=await request('/api/v1/analytics/teacher/overview');return PHASE5_OVERVIEW}
  finally{PHASE5_LOADING=false}
}
function phase5Class(){return (PHASE5_OVERVIEW?.classes||[]).find(c=>String(c.code)===String(PHASE5_ACTIVE_CLASS))||null}
function phase5Assignment(){const c=phase5Class();return (c?.assignments||[]).find(a=>String(a.id)===String(PHASE5_ACTIVE_ASSIGNMENT))||null}
async function phase5SelectClass(code){PHASE5_ACTIVE_CLASS=String(code||'');PHASE5_ACTIVE_ASSIGNMENT='';PHASE5_ASSIGNMENT_REPORT=null;renderTeacherAnalytics()}
async function phase5SelectAssignment(id){PHASE5_ACTIVE_ASSIGNMENT=String(id||'');PHASE5_ASSIGNMENT_REPORT=null;renderTeacherAnalytics();try{PHASE5_ASSIGNMENT_REPORT=await request('/api/v1/analytics/assignments/'+encodeURIComponent(id));renderTeacherAnalytics()}catch(e){toast(e.message,'error')}}
function phase5SetFilter(v){PHASE5_FILTER=String(v||'').toLowerCase();renderTeacherAnalytics()}
async function phase5Refresh(){PHASE5_OVERVIEW=null;PHASE5_ASSIGNMENT_REPORT=null;await phase5LoadOverview(true);if(PHASE5_ACTIVE_ASSIGNMENT){try{PHASE5_ASSIGNMENT_REPORT=await request('/api/v1/analytics/assignments/'+PHASE5_ACTIVE_ASSIGNMENT)}catch(e){console.warn(e)}}renderTeacherAnalytics();toast('Analytics refreshed from database','success')}
async function phase5ExportAssignment(id){
  try{
    let res=await fetch(API+'/api/v1/analytics/assignments/'+id+'/export.csv',{headers:{Authorization:'Bearer '+SESSION.access_token}});
    if(res.status===401&&await refreshAuthSession())res=await fetch(API+'/api/v1/analytics/assignments/'+id+'/export.csv',{headers:{Authorization:'Bearer '+SESSION.access_token}});
    if(!res.ok)throw new Error('Could not export report');
    const blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;
    const cd=res.headers.get('content-disposition')||'',m=cd.match(/filename="?([^";]+)"?/i);a.download=m?.[1]||'assignment_results.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('CSV report downloaded','success');
  }catch(e){toast(e.message,'error')}
}
const _phase5LegacyRenderTeacherAnalytics=renderTeacherAnalytics;
renderTeacherAnalytics=async function(){
  const out=$('#teacherAnalyticsOut');if(!out)return;
  if(getRole()!=='teacher'){out.innerHTML='<div class="p5-card">Teacher access required.</div>';return}
  if(!PHASE5_OVERVIEW){out.innerHTML='<div class="p5-card"><div class="card-title">Loading secure analytics…</div><p class="p5-muted">Reading classes, assignments and verified submissions from the database.</p></div>';try{await phase5LoadOverview();}catch(e){out.innerHTML='<div class="p5-card"><div class="card-title">Analytics unavailable</div><p class="p5-muted">'+safe(e.message)+'</p><button class="btn primary small" style="margin-top:12px" onclick="phase5Refresh()">Retry</button></div>';return}}
  const data=PHASE5_OVERVIEW||{summary:{},classes:[]},sum=data.summary||{},classes=data.classes||[];
  if(!PHASE5_ACTIVE_CLASS&&classes.length)PHASE5_ACTIVE_CLASS=String(classes[0].code);
  const cls=phase5Class(),assignments=cls?.assignments||[];
  if(PHASE5_ACTIVE_ASSIGNMENT&&!assignments.some(a=>String(a.id)===String(PHASE5_ACTIVE_ASSIGNMENT))){PHASE5_ACTIVE_ASSIGNMENT='';PHASE5_ASSIGNMENT_REPORT=null}
  const classCards=classes.length?classes.map(c=>`<article class="p5-item ${String(c.code)===String(PHASE5_ACTIVE_CLASS)?'active':''}" onclick="phase5SelectClass('${safe(c.code)}')"><span class="badge brand">${safe(c.code)}</span><h4>${safe(c.className||'Academic Class')}</h4><div class="p5-muted">${safe(c.subject||'General')} · ${p5Num(c.studentCount)} students</div><div class="p5-meta"><span class="badge">${p5Num(c.assignmentCount)} assignments</span><span class="badge">${p5Num(c.submissionCount)} submissions</span><span class="badge good">${p5Pct(c.average)}% avg</span></div></article>`).join(''):'<div class="p5-muted">No classes created yet.</div>';
  const assignmentCards=assignments.length?assignments.map(a=>{const x=a.analytics||{},completion=p5Pct(x.completionRate);return `<article class="p5-item ${String(a.id)===String(PHASE5_ACTIVE_ASSIGNMENT)?'active':''}" onclick="phase5SelectAssignment('${safe(a.id)}')"><span class="badge brand">${safe(assignmentTypeLabel(a))}</span><h4>${safe(a.title||'Untitled assessment')}</h4><div class="p5-muted">${p5Num(x.submitted)}/${p5Num(x.assigned)} submitted · ${p5Pct(x.average)}% average</div><div class="p5-progress"><i style="width:${Math.min(100,completion)}%"></i></div><div class="p5-meta"><span class="badge">${completion}% complete</span><span class="badge">${p5Num(x.pending)} pending</span></div></article>`}).join(''):'<div class="p5-muted">No assignments in this class yet.</div>';
  let report='<div class="p5-card"><div class="card-title">Select an assignment</div><p class="p5-muted">Open an assignment to view verified marks, pending students and question difficulty.</p></div>';
  if(PHASE5_ACTIVE_ASSIGNMENT&&!PHASE5_ASSIGNMENT_REPORT)report='<div class="p5-card"><div class="card-title">Loading assignment report…</div><p class="p5-muted">Calculating latest attempts and question performance.</p></div>';
  if(PHASE5_ASSIGNMENT_REPORT){
    const r=PHASE5_ASSIGNMENT_REPORT,s=r.summary||{},a=r.assignment||{},filter=PHASE5_FILTER;
    const students=(r.students||[]).filter(x=>!filter||[x.studentName,x.studentEmail,x.studentCode,x.status].some(v=>String(v||'').toLowerCase().includes(filter)));
    const rows=students.length?students.map(st=>`<tr><td><b>${safe(st.studentName||'Student')}</b><br><small class="p5-muted">${safe(st.studentEmail||'')}</small></td><td>${safe(st.studentCode||'—')}</td><td><span class="p5-status ${st.status==='submitted'?'done':''}">${safe(st.status==='submitted'?'Submitted':'Pending')}</span></td><td>${st.score==null?'—':safe(st.score)+'/'+safe(st.total)}</td><td>${st.pct==null?'—':p5Pct(st.pct)+'%'}</td><td>${st.correct==null?'—':safe(st.correct)}</td><td>${st.wrong==null?'—':safe(st.wrong)}</td><td>${safe(p5Date(st.submittedAt))}</td></tr>`).join(''):'<tr><td colspan="8">No matching students.</td></tr>';
    const weak=(r.weakQuestions||[]).length?(r.weakQuestions||[]).map(q=>`<div class="p5-q"><div class="p5-q-top"><h5>Q${safe(q.position)}. ${safe(q.question)}</h5><span class="badge ${q.accuracy<50?'warn':''}">${p5Pct(q.accuracy)}% accuracy</span></div><small>${p5Num(q.correct)} correct · ${p5Num(q.wrong)} wrong · ${p5Num(q.answered)} answered</small></div>`).join(''):'<p class="p5-muted">Question analysis appears after students submit.</p>';
    report=`<div class="p5-card"><div class="p5-toolbar"><div><span class="badge brand">Verified database report</span><h3 style="margin:8px 0 4px">${safe(a.title||'Assignment')}</h3><p class="p5-muted">${safe(a.className||'Class')} · ${safe(a.subject||'General')}</p></div><div class="quick-actions"><button class="btn ghost small" onclick="phase5Refresh()">Refresh</button><button class="btn primary small" onclick="phase5ExportAssignment('${safe(a.id)}')">Export CSV</button></div></div><div class="p5-kpis"><div class="p5-kpi"><span>Assigned</span><b>${p5Num(s.assigned)}</b></div><div class="p5-kpi"><span>Completion</span><b>${p5Pct(s.completionRate)}%</b></div><div class="p5-kpi"><span>Average</span><b>${p5Pct(s.average)}%</b></div><div class="p5-kpi"><span>Highest</span><b>${p5Pct(s.highest)}%</b></div><div class="p5-kpi"><span>Lowest</span><b>${p5Pct(s.lowest)}%</b></div></div><div class="p5-toolbar" style="margin-top:16px"><div class="card-title">Student results</div><input class="input" placeholder="Filter student, email, code or status" value="${safe(PHASE5_FILTER)}" oninput="phase5SetFilter(this.value)"></div><div class="p5-table-wrap"><table class="p5-table"><thead><tr><th>Student</th><th>Code</th><th>Status</th><th>Marks</th><th>Score</th><th>Correct</th><th>Wrong</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table></div><div class="card-title" style="margin-top:18px">Weak-question analysis</div><div class="p5-questions" style="margin-top:10px">${weak}</div></div>`;
  }
  out.innerHTML=`<div class="p5-analytics"><section class="p5-hero"><div><span class="badge brand">Teacher intelligence workspace</span><h2>Professional class analytics</h2><p>All marks, completion rates and question insights are calculated from secure server submissions.</p></div><div class="quick-actions"><button class="btn ghost" onclick="showPanel('teacherStudentsPanel')">Manage classes</button><button class="btn primary" onclick="phase5Refresh()">Refresh data</button></div></section><div class="p5-kpis"><div class="p5-kpi"><span>Classes</span><b>${p5Num(sum.classes)}</b></div><div class="p5-kpi"><span>Students</span><b>${p5Num(sum.students)}</b></div><div class="p5-kpi"><span>Assignments</span><b>${p5Num(sum.assignments)}</b></div><div class="p5-kpi"><span>Submissions</span><b>${p5Num(sum.submissions)}</b></div><div class="p5-kpi"><span>Overall average</span><b>${p5Pct(sum.average)}%</b></div></div><div class="p5-grid"><section class="p5-card"><div class="card-title">Classes</div><div class="p5-list" style="margin-top:12px">${classCards}</div></section><section class="p5-card"><div class="card-title">${cls?safe(cls.className)+' assignments':'Assignments'}</div><div class="p5-list" style="margin-top:12px">${assignmentCards}</div></section></div>${report}</div>`;
}
const _phase5RenderPanel=renderPanel;
renderPanel=function(id){_phase5RenderPanel(id);if(id==='teacherAnalyticsPanel'){PHASE5_OVERVIEW=null;PHASE5_ASSIGNMENT_REPORT=null;renderTeacherAnalytics()}}
