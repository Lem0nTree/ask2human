"use client";

import { useEffect, useRef, useState } from "react";

export function VideoExplanation() {
  const [isOpen, setIsOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [isOpen]);

  return <>
    <button ref={triggerRef} className="eyebrow video-intro" type="button" aria-haspopup="dialog" onClick={() => setIsOpen(true)}>
      <i aria-hidden="true" /><span>Start here. Watch the video explanation <span aria-hidden="true">→</span></span>
    </button>
    <dialog ref={dialogRef} className="video-modal" aria-label="Video explanation" onClose={() => setIsOpen(false)} onCancel={() => setIsOpen(false)} onClick={(event) => {
      if (event.target === event.currentTarget) setIsOpen(false);
    }}>
      <div className="video-modal__content">
        <button className="video-modal__close" type="button" aria-label="Close video" autoFocus onClick={() => setIsOpen(false)}>×</button>
        {isOpen ? <iframe
          src="https://www.youtube.com/embed/1xZobtI0x9M?autoplay=1&playsinline=1"
          title="ask2human video explanation"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        /> : null}
      </div>
    </dialog>
  </>;
}
