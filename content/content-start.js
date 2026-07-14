(() => {
  const nonce = crypto.randomUUID();
  window.__BAG_NONCE__ = nonce;
  if (document.documentElement) {
    document.documentElement.setAttribute('data-bag-hook-nonce', nonce);
  }
})();
