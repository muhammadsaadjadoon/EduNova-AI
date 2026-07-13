/* Phase 9: non-invasive frontend runtime helpers and accessibility hardening. */
(function(){
  'use strict';
  const state={lastFocus:null};
  const visibleModal=()=>Array.from(document.querySelectorAll('.modal')).find(m=>getComputedStyle(m).display!=='none'&&m.getAttribute('aria-hidden')!=='true');
  const focusables=root=>Array.from(root.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(el=>!el.disabled&&el.offsetParent!==null);

  window.uiBusy=function(button,busy,label){
    if(!button)return;
    if(busy){button.dataset.runtimeLabel=button.innerHTML;button.setAttribute('aria-busy','true');button.disabled=true;button.innerHTML='<span class="runtime-spinner" aria-hidden="true"></span>'+String(label||'Working…');}
    else{button.removeAttribute('aria-busy');button.disabled=false;if(button.dataset.runtimeLabel){button.innerHTML=button.dataset.runtimeLabel;delete button.dataset.runtimeLabel;}}
  };
  window.uiEmpty=function(message){return '<div class="runtime-empty" role="status">'+String(message||'No data available.')+'</div>'};
  window.uiError=function(message){return '<div class="runtime-error" role="alert">'+String(message||'Something went wrong.')+'</div>'};

  function enhance(){
    document.querySelectorAll('.modal').forEach(modal=>{modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');if(!modal.hasAttribute('aria-hidden'))modal.setAttribute('aria-hidden',getComputedStyle(modal).display==='none'?'true':'false');});
    document.querySelectorAll('button.x').forEach(b=>{if(!b.getAttribute('aria-label'))b.setAttribute('aria-label','Close dialog')});
    document.querySelectorAll('button').forEach(b=>{if(!b.getAttribute('type'))b.setAttribute('type','button')});
    document.querySelectorAll('input,textarea,select').forEach(el=>{if(!el.getAttribute('aria-label')&&!el.id){const p=el.getAttribute('placeholder');if(p)el.setAttribute('aria-label',p)}});
    document.querySelectorAll('img:not([alt])').forEach(img=>img.setAttribute('alt',''));
  }
  enhance();
  new MutationObserver(enhance).observe(document.body,{subtree:true,childList:true});

  document.addEventListener('keydown',e=>{
    const modal=visibleModal();
    if(e.key==='Escape'&&modal){const close=modal.querySelector('.x,[data-close-modal]');if(close){e.preventDefault();close.click();}}
    if(e.key==='Tab'&&modal){const list=focusables(modal);if(!list.length)return;const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
  });

  const observer=new MutationObserver(()=>{
    const modal=visibleModal();
    document.querySelectorAll('.modal').forEach(m=>m.setAttribute('aria-hidden',m===modal?'false':'true'));
    if(modal&& !modal.contains(document.activeElement)){state.lastFocus=document.activeElement;const first=focusables(modal)[0];if(first)setTimeout(()=>first.focus(),0)}
    if(!modal&&state.lastFocus&&document.contains(state.lastFocus)){state.lastFocus.focus({preventScroll:true});state.lastFocus=null}
  });
  observer.observe(document.body,{attributes:true,subtree:true,attributeFilter:['class','style']});

  window.addEventListener('unhandledrejection',e=>{console.error('Unhandled application error:',e.reason);if(typeof window.toast==='function')window.toast('An unexpected error occurred. Please try again.','error')});
  window.addEventListener('error',e=>console.error('Frontend runtime error:',e.error||e.message));
})();
