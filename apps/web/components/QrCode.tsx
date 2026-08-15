'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders the ticket's signed token as a real, scannable QR code.
 *
 * The token is an opaque HMAC issued by ticket-service — it carries no
 * passenger data, so the image is safe to print, screenshot or share. The
 * boarding scanner verifies the signature server-side; nothing about the
 * passenger can be read out of the code itself.
 */
export function QrCode({ value, size = 148 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string>('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 0,
      width: size,
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then((s) => { if (alive) setSvg(s); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [value, size]);

  if (failed) {
    return (
      <div className="qr-box" style={{ width: size, height: size }}>
        <span className="small muted center">
          Could not draw the code.<br />Show the PNR at boarding.
        </span>
      </div>
    );
  }

  if (!svg) {
    return <div className="skeleton" style={{ width: size, height: size, borderRadius: 8 }} />;
  }

  return (
    <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="Boarding QR code" />
  );
}
