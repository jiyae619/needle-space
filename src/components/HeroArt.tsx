// Landing-page hero illustrations. Three concepts on one idea: the Space
// Needle's disc is a coffee saucer. Pick one with `?art=poster|stars|latte`.

export const HERO_ART = ["poster", "stars", "latte"] as const;
export type HeroArtVariant = (typeof HERO_ART)[number];

// Logo palette, so the art and the header icon read as one family.
const RED = "#C8321F";
const RED_DARK = "#9E2416";
const TEAL = "#5FA88A";
const NAVY = "#1D3A4C";
const STEAM = "#D9B27C";

/** The Needle from the ground up; the saucer top sits at y = -236. */
function Needle({ color, halo = TEAL }: { color: string; halo?: string }) {
  return (
    <g>
      {/* legs: two outer, one core, pinched at the waist */}
      <path d="M-14 -214 C-6 -160 -8 -110 -46 0 L-34 0 C-2 -110 0 -160 -6 -214 Z" fill={color} />
      <path d="M14 -214 C6 -160 8 -110 46 0 L34 0 C2 -110 0 -160 6 -214 Z" fill={color} />
      <path d="M-4 -214 L4 -214 L6 0 L-6 0 Z" fill={color} />
      {/* lower ring */}
      <rect x="-30" y="-58" width="60" height="5" rx="2" fill={color} />
      {/* saucer underside + rim */}
      <path d="M-22 -212 L22 -212 L62 -228 L-62 -228 Z" fill={color} />
      <rect x="-64" y="-236" width="128" height="8" rx="3" fill={halo} />
      <rect x="-64" y="-230" width="128" height="3" fill={color} opacity="0.35" />
    </g>
  );
}

/** A cup sitting on the saucer (the logo), with rising steam. */
function Cup({ steam = STEAM }: { steam?: string }) {
  return (
    <g>
      <path
        d="M-40 -292 L40 -292 C40 -262 30 -240 0 -238 C-30 -240 -40 -262 -40 -292 Z"
        fill={RED}
      />
      <path d="M22 -292 L40 -292 C40 -262 30 -240 0 -238 C18 -244 24 -266 22 -292 Z" fill={RED_DARK} />
      <path d="M38 -284 C58 -286 58 -258 32 -256" fill="none" stroke={RED} strokeWidth="6" strokeLinecap="round" />
      <path d="M-32 -286 C-33 -270 -28 -254 -20 -246" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" />
      <path d="M-8 -300 C-18 -316 2 -326 -8 -344" fill="none" stroke={steam} strokeWidth="4" strokeLinecap="round" />
      <path d="M8 -302 C0 -318 18 -330 8 -352" fill="none" stroke={steam} strokeWidth="4" strokeLinecap="round" />
    </g>
  );
}

/** 1 · Travel poster: the steam becomes Seattle's sky. */
function Poster() {
  return (
    <svg viewBox="0 0 400 480" role="img" aria-labelledby="art-poster-t">
      <title id="art-poster-t">A coffee cup on the Space Needle&apos;s saucer at sunset, Mount Rainier behind</title>
      <defs>
        <clipPath id="arch">
          <path d="M20 480 L20 200 A180 180 0 0 1 380 200 L380 480 Z" />
        </clipPath>
        <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F5C4AE" />
          <stop offset="0.55" stopColor="#F3D9BF" />
          <stop offset="1" stopColor="#EDE3CF" />
        </linearGradient>
      </defs>
      <g clipPath="url(#arch)">
        <rect width="400" height="480" fill="url(#dusk)" />
        {/* sun rays */}
        <g opacity="0.22" stroke="#E8521C" strokeWidth="10">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (Math.PI * (i + 0.5)) / 12;
            return <line key={i} x1="200" y1="330" x2={200 - Math.cos(a) * 400} y2={330 - Math.sin(a) * 400} />;
          })}
        </g>
        <circle cx="200" cy="330" r="92" fill="#E8521C" opacity="0.9" />
        {/* Rainier */}
        <path d="M40 360 L150 260 L172 272 L196 246 L222 268 L240 258 L360 360 Z" fill="#8FA7B3" />
        <path d="M150 260 L172 272 L196 246 L222 268 L240 258 L214 280 L196 270 L176 286 Z" fill="#F5EFE3" />
        {/* skyline */}
        <path d="M20 400 L20 372 L44 372 L44 356 L64 356 L64 380 L84 380 L84 340 L104 340 L104 384 L284 384 L284 350 L300 350 L300 332 L318 332 L318 370 L340 370 L340 356 L380 356 L380 400 Z" fill="#3E5F73" />
        {/* water */}
        <rect y="400" width="400" height="80" fill={NAVY} />
        <g stroke="#F5C4AE" strokeWidth="3" strokeLinecap="round" opacity="0.6">
          <line x1="150" y1="418" x2="250" y2="418" />
          <line x1="170" y1="434" x2="230" y2="434" />
          <line x1="186" y1="450" x2="214" y2="450" />
        </g>
        {/* rain */}
        <g stroke={NAVY} strokeWidth="2" strokeLinecap="round" opacity="0.18">
          {Array.from({ length: 22 }, (_, i) => {
            const x = 30 + ((i * 53) % 340);
            const y = 60 + ((i * 97) % 200);
            return <line key={i} x1={x} y1={y} x2={x - 6} y2={y + 16} />;
          })}
        </g>
        <g transform="translate(200 408)">
          <Needle color={NAVY} />
          <Cup steam="#F5EFE3" />
        </g>
      </g>
      <path d="M20 480 L20 200 A180 180 0 0 1 380 200 L380 480" fill="none" stroke="#2A1D14" strokeWidth="2" />
    </svg>
  );
}

// Brightest stars trace the Needle; the rest are the other cafes in the index.
const NEEDLE_STARS: [number, number][] = [
  [200, 60], [200, 118], [140, 150], [260, 150], [182, 176], [218, 176],
  [196, 260], [204, 260], [150, 400], [250, 400], [174, 330], [226, 330],
];
const NEEDLE_LINES = [
  [0, 1], [1, 2], [1, 3], [2, 4], [3, 5], [4, 5], [4, 6], [5, 7], [6, 10],
  [7, 11], [10, 8], [11, 9], [10, 11],
];

/** 2 · Constellation: every star is a cafe; the bright ones draw the Needle. */
function Stars() {
  const field = Array.from({ length: 70 }, (_, i) => ({
    x: (i * 137.5) % 400,
    y: (i * 71.3 + (i % 7) * 23) % 480,
    r: i % 9 === 0 ? 1.8 : 1,
  }));
  return (
    <svg viewBox="0 0 400 480" role="img" aria-labelledby="art-stars-t">
      <title id="art-stars-t">A night sky where cafe stars join into the Space Needle, with a flying saucer carrying a coffee cup</title>
      <defs>
        <radialGradient id="glow" cx="0.5" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#3B2A1E" />
          <stop offset="1" stopColor="#1A120C" />
        </radialGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F5C4AE" stopOpacity="0.45" />
          <stop offset="1" stopColor="#F5C4AE" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="400" height="480" rx="10" fill="url(#glow)" />
      {field.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#F5EFE3" opacity={0.25 + (i % 5) * 0.1} />
      ))}
      <g stroke="#F5C4AE" strokeWidth="1.2" strokeDasharray="3 4" opacity="0.7">
        {NEEDLE_LINES.map(([a, b], i) => (
          <line key={i} x1={NEEDLE_STARS[a][0]} y1={NEEDLE_STARS[a][1]} x2={NEEDLE_STARS[b][0]} y2={NEEDLE_STARS[b][1]} />
        ))}
      </g>
      {NEEDLE_STARS.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="7" fill="#E8521C" opacity="0.25" />
          <circle cx={x} cy={y} r="3" fill="#FBE6D6" />
        </g>
      ))}
      {/* moon = cup seen from above */}
      <circle cx="330" cy="80" r="26" fill="#F5EFE3" />
      <circle cx="330" cy="80" r="19" fill="#8A5A36" />
      <path d="M330 90 C318 80 320 70 326 70 C329 70 330 73 330 75 C330 73 331 70 334 70 C340 70 342 80 330 90 Z" fill="#FBF3E6" />
      {/* UFO = saucer + cup, beaming up a laptop */}
      <g transform="translate(78 250) rotate(-12)">
        <path d="M-22 6 L22 6 L52 150 L-52 150 Z" fill="url(#beam)" />
        <ellipse cx="0" cy="0" rx="40" ry="8" fill={TEAL} />
        <path d="M-18 -4 L18 -4 C18 -18 12 -26 0 -26 C-12 -26 -18 -18 -18 -4 Z" fill={RED} />
        <path d="M16 -18 C26 -18 26 -8 16 -8" stroke={RED} strokeWidth="3" fill="none" />
        <circle cx="-24" cy="1" r="1.6" fill="#FBE6D6" />
        <circle cx="0" cy="3" r="1.6" fill="#FBE6D6" />
        <circle cx="24" cy="1" r="1.6" fill="#FBE6D6" />
      </g>
      {/* the laptop being beamed up */}
      <g transform="translate(100 356) rotate(-12)">
        <rect x="-16" y="-12" width="32" height="20" rx="2" fill="#F5EFE3" />
        <rect x="-13" y="-9" width="26" height="14" rx="1" fill="#E8521C" opacity="0.7" />
        <rect x="-20" y="8" width="40" height="4" rx="2" fill="#D9CAAF" />
      </g>
      {/* ground: hills and water */}
      <path d="M0 440 C80 420 140 432 200 428 C270 424 330 412 400 430 L400 480 L0 480 Z" fill="#0F0A07" />
      <text x="200" y="462" textAnchor="middle" fill="#F5C4AE" opacity="0.8" fontSize="10" letterSpacing="3">
        EACH STAR IS A WORKING CAFE
      </text>
    </svg>
  );
}

/** 3 · Latte art: the Needle poured in foam, laptop at the edge of frame. */
function Latte() {
  return (
    <svg viewBox="0 0 400 480" role="img" aria-labelledby="art-latte-t">
      <title id="art-latte-t">A latte seen from above with the Space Needle poured in the foam, next to a laptop</title>
      <rect width="400" height="480" rx="10" fill="#E3D3B4" />
      {/* wood grain */}
      <g stroke="#C9B38E" strokeWidth="1.5" fill="none" opacity="0.6">
        {Array.from({ length: 9 }, (_, i) => (
          <path key={i} d={`M0 ${30 + i * 56} C120 ${20 + i * 56} 260 ${46 + i * 56} 400 ${28 + i * 56}`} />
        ))}
      </g>
      {/* laptop corner */}
      <g transform="translate(262 -30) rotate(18)">
        <rect width="220" height="170" rx="12" fill="#2A1D14" />
        <rect x="12" y="12" width="196" height="118" rx="4" fill="#3E2E22" />
        {Array.from({ length: 24 }, (_, i) => (
          <rect key={i} x={16 + (i % 8) * 24} y={138 + Math.floor(i / 8) * 9} width="18" height="6" rx="1.5" fill="#4A3728" />
        ))}
      </g>
      {/* coffee ring stain */}
      <circle cx="84" cy="96" r="44" fill="none" stroke="#B99A6E" strokeWidth="4" opacity="0.35" strokeDasharray="120 12 60 8" />
      <g transform="translate(196 270) rotate(-8)">
        {/* saucer */}
        <circle r="150" fill="#F5EFE3" />
        <circle r="150" fill="none" stroke="#D9CAAF" strokeWidth="2" />
        <circle r="112" fill="none" stroke="#D9CAAF" strokeWidth="1.5" />
        {/* spoon */}
        <g transform="rotate(40)">
          <rect x="-4" y="126" width="8" height="70" rx="4" fill="#A8A29A" />
          <ellipse cx="0" cy="124" rx="10" ry="14" fill="#BDB7AE" />
        </g>
        {/* handle */}
        <rect x="100" y="-16" width="44" height="32" rx="16" fill={RED} />
        <rect x="112" y="-8" width="22" height="16" rx="8" fill="#F5EFE3" />
        {/* cup */}
        <circle r="108" fill={RED} />
        <circle r="96" fill="#8A5A36" />
        <circle r="96" fill="none" stroke="#6B4226" strokeWidth="6" opacity="0.6" />
        {/* foam Needle */}
        <g fill="#FBF3E6" transform="translate(0 -6) scale(0.85)">
          <path d="M-2 -86 C-6 -76 -2 -70 0 -66 C2 -70 6 -76 2 -86 Z" />
          <path d="M-60 -48 C-40 -64 40 -64 60 -48 C44 -38 -44 -38 -60 -48 Z" />
          <path d="M-12 -40 C-6 -10 -8 30 -40 80 C-30 82 -24 82 -18 80 C-4 40 -2 0 -4 -40 Z" />
          <path d="M12 -40 C6 -10 8 30 40 80 C30 82 24 82 18 80 C4 40 2 0 4 -40 Z" />
          <path d="M-3 -40 L3 -40 L4 80 L-4 80 Z" />
          <path d="M-26 28 C-10 24 10 24 26 28 C10 32 -10 32 -26 28 Z" />
          {/* foam shoreline under the legs */}
          <path d="M-88 80 C-50 68 -20 86 0 78 C20 70 50 86 88 76 C70 100 -70 100 -88 80 Z" />
        </g>
      </g>
    </svg>
  );
}

export default function HeroArt({ variant }: { variant: HeroArtVariant }) {
  const Art = { poster: Poster, stars: Stars, latte: Latte }[variant];
  return <Art />;
}
