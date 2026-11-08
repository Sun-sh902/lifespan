// Runs before first paint so a saved theme never flashes the wrong colors.
try {
  var saved = localStorage.getItem('lifespan-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (e) { /* storage unavailable */ }
