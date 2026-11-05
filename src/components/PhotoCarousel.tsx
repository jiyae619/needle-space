"use client";

import Image from "next/image";
import { useRef, useState } from "react";

export type Slide = { url: string; caption?: string };

// The cafe page's top photo. With more than one photo it scrolls sideways
// (swipe on a phone, arrows anywhere); each photo can carry a caption, e.g. the
// mood words that were read from it.
export default function PhotoCarousel({ slides, name }: { slides: Slide[]; name: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const go = (to: number) => {
    const el = track.current;
    if (!el) return;
    const n = (to + slides.length) % slides.length;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: n * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };
  const onScroll = () => {
    const el = track.current;
    if (el) setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  return (
    <div className="rc-photo">
      <div ref={track} onScroll={onScroll} className="rc-photo-track">
        {slides.map((s, n) => (
          <figure key={s.url} className="rc-photo-slide">
            <Image src={s.url} alt={n === 0 ? `Inside ${name}` : `${name}, photo ${n + 1}`} fill
              sizes="(max-width: 768px) 100vw, 640px" className="object-cover" unoptimized priority={n === 0} />
            {s.caption && <figcaption className="rc-photo-cap">{s.caption}</figcaption>}
          </figure>
        ))}
      </div>
      {slides.length > 1 && (
        <>
          <button type="button" className="rc-photo-arrow is-prev" aria-label="Previous photo" onClick={() => go(index - 1)}>‹</button>
          <button type="button" className="rc-photo-arrow is-next" aria-label="Next photo" onClick={() => go(index + 1)}>›</button>
          <span className="rc-photo-count" aria-live="polite">{index + 1} / {slides.length}</span>
        </>
      )}
    </div>
  );
}
