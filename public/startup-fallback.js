window.addEventListener('error', event => {
  if (!(event instanceof ErrorEvent)) return;
  const startup = document.querySelector('#startup');
  if (!startup || startup.hidden || startup.dataset.ready === 'true') return;
  if (startup.dataset.phase === 'installing') return;
  const status = startup.querySelector('.startup-status');
  const error = startup.querySelector('.startup-error');
  status.textContent = 'Ember could not finish starting.';
  error.textContent = 'Reload Ember to try again.';
  error.hidden = false;
  startup.querySelector('.startup-progress').hidden = true;
  startup.querySelector('.startup-actions').hidden = false;
});
document.addEventListener('click', event => {
  if (document.querySelector('#startup')?.dataset.controlled === 'true') return;
  if (event.target.closest('[data-action="retry-startup"]')) location.reload();
});
