// Script pour forcer les styles WhatsApp
(function() {
  const style = document.createElement('style');
  style.id = 'force-whatsapp-style';
  style.textContent = `
    .contact-bubble {
      max-width: 65% !important;
      width: fit-content !important;
      padding: 6px 10px !important;
      border-radius: 8px !important;
      font-size: 13px !important;
      line-height: 1.4 !important;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1) !important;
      margin-bottom: 2px !important;
    }
    .contact-bubble.inbound {
      align-self: flex-start !important;
      background: #fff !important;
      color: #111b21 !important;
      border-top-left-radius: 2px !important;
      border: 1px solid #e8ecef !important;
    }
    .contact-bubble.outbound {
      align-self: flex-end !important;
      background: #d9fdd3 !important;
      color: #111b21 !important;
      border-top-right-radius: 2px !important;
      border: none !important;
    }
    .contact-thread-body {
      padding: 12px !important;
      gap: 4px !important;
      background: #efeae2 !important;
      background-image: 
        linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px) !important;
      background-size: 20px 20px !important;
    }
    .contact-bubble .bubble-time {
      font-size: 10px !important;
      margin-top: 2px !important;
    }
    .contact-bubble .bubble-label {
      font-size: 11px !important;
      margin-bottom: 2px !important;
    }
  `;
  document.head.appendChild(style);
  console.log('✅ Styles WhatsApp forcés appliqués!');
})();
