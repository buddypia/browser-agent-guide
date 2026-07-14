(function() {
  let nonce = '';
  if (document.documentElement) {
    nonce = document.documentElement.getAttribute('data-bag-hook-nonce') || '';
    if (nonce) {
      document.documentElement.removeAttribute('data-bag-hook-nonce');
    }
  }

  if (!nonce && document.documentElement) {
    const observer = new MutationObserver(() => {
      const val = document.documentElement.getAttribute('data-bag-hook-nonce');
      if (val) {
        nonce = val;
        document.documentElement.removeAttribute('data-bag-hook-nonce');
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { attributes: true });
    window.addEventListener('DOMContentLoaded', () => observer.disconnect(), { once: true });
  }

  const originalWriteText = (typeof Clipboard !== 'undefined' && Clipboard.prototype) ? Clipboard.prototype.writeText : null;
  const originalNavWriteText = (typeof navigator !== 'undefined' && navigator.clipboard) ? navigator.clipboard.writeText : null;

  function dispatchClipboardEvent(text) {
    try {
      const event = new CustomEvent('BAG_CLIPBOARD_WRITE', {
        detail: { text, nonce }
      });
      window.dispatchEvent(event);
    } catch (e) {
      // ignore event dispatch errors
    }
  }

  if (typeof Clipboard !== 'undefined' && Clipboard.prototype) {
    Clipboard.prototype.writeText = async function(text) {
      dispatchClipboardEvent(text);
      if (originalWriteText) {
        return originalWriteText.apply(this, arguments);
      }
    };
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText = async function(text) {
      dispatchClipboardEvent(text);
      if (originalNavWriteText) {
        return originalNavWriteText.apply(this, arguments);
      }
    };
  }
})();
