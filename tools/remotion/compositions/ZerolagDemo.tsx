import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { colors, fonts } from '../lib/theme';
import { IPhone17ProFrame, SCREEN_W, SCREEN_H } from '../components/IPhone17ProFrame';
import { IOSKeyboard } from '../components/IOSKeyboard';

// ─── Scene timing (frames @ 30fps) ───
const TITLE_DUR = 60;
const PHONES_DUR = 30;
const TYPING_DUR = 610;
const HOLD_DUR = 50;
const OUTRO_DUR = 45;

const TITLE_START = 0;
const PHONES_START = TITLE_DUR; // 60
const TYPING_START = PHONES_START + PHONES_DUR; // 90
const HOLD_START = TYPING_START + TYPING_DUR; // 700
const OUTRO_START = HOLD_START + HOLD_DUR; // 750

export const ZEROLAG_TOTAL_FRAMES = OUTRO_START + OUTRO_DUR; // 795

// ─── iPhone 17 Pro safe area ───
const SAFE_AREA_TOP = 59; // Below Dynamic Island
const PHONE_SCALE = 1.12; // Scale up to fill more of the frame

// Claude Code header: tab bar + session info + prompt context from screenshot
const HEADER_H = 120;

// Terminal typing overlay: aligned with the ❯ prompt position in the Claude Code screenshot
const TERMINAL_TOP = 185;
const TERMINAL_LEFT = 14;
const TERMINAL_FONT = 21; // Slightly smaller to fit toolbar below

// Codeman toolbar from screenshot (bottom section showing /init, /clear, Run, etc.)
const TOOLBAR_H = 95;

// ─── Typing schedule ───
const CORRECT_TEXT =
  'zerolag technology brings in a visual dom overlay to make typing instant, even if your codeman server is on the other side of the world';
const FRAME_GAP = 4; // ~133ms per keystroke (~75 WPM)

// Remote connection lag: 600ms–2.7s per char (18–80 frames @ 30fps).
// Periodic spikes simulate packet loss / retransmission bursts.
// TCP head-of-line blocking causes a single spike to freeze all subsequent chars.
const LAGGY_DELAYS = [
  24, 30, 26, 32, 72, 28, 22, 34, 26, 30, 20, 28, 36, 24, 30, 22, 26, 34, 28, 20, 68, 30, 24, 32,
  26, 22, 28, 34, 30, 26, 32, 24, 80, 22, 30, 26, 28, 34, 24, 30,
];

type KeyAction = { frame: number; char: string; lagDelay: number };

const buildSchedule = (): KeyAction[] => {
  const actions: KeyAction[] = [];
  const lag = (i: number) => LAGGY_DELAYS[i % LAGGY_DELAYS.length];

  for (let i = 0; i < CORRECT_TEXT.length; i++) {
    actions.push({ frame: i * FRAME_GAP, char: CORRECT_TEXT[i], lagDelay: lag(i) });
  }

  return actions;
};

const TYPING_SCHEDULE = buildSchedule();

/**
 * Replay actions in order up to current frame, computing the visible text buffer.
 * TCP-ordered: stops at first unresolved echo (head-of-line blocking).
 */
const computeVisibleText = (frame: number, withLag: boolean): string => {
  let buffer = '';
  for (const a of TYPING_SCHEDULE) {
    const threshold = withLag ? a.frame + a.lagDelay : a.frame;
    if (frame < threshold) break;
    buffer += a.char;
  }
  return buffer;
};

// ─── iOS Status Bar (sits in the safe area, flanking Dynamic Island) ───
const IOSStatusBar: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 17,
      left: 0,
      right: 0,
      height: 20,
      display: 'flex',
      justifyContent: 'space-between',
      padding: '0 30px',
      fontSize: 15,
      fontFamily: fonts.ui,
      fontWeight: 600,
      color: '#fff',
      zIndex: 40,
    }}
  >
    <span>9:41</span>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {/* Signal */}
      <svg width="17" height="12" viewBox="0 0 17 12">
        <rect x="0" y="8" width="3" height="4" rx="0.5" fill="#fff" />
        <rect x="4.5" y="5" width="3" height="7" rx="0.5" fill="#fff" />
        <rect x="9" y="2" width="3" height="10" rx="0.5" fill="#fff" />
        <rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="#fff" />
      </svg>
      {/* WiFi */}
      <svg width="16" height="12" viewBox="0 0 16 12">
        <path
          d="M4.5 8.5C5.5 7.2 6.7 6.5 8 6.5s2.5.7 3.5 2"
          stroke="#fff"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M1.5 5.5C3.5 3 5.7 1.5 8 1.5s4.5 1.5 6.5 4"
          stroke="#fff"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11" r="1.5" fill="#fff" />
      </svg>
      {/* Battery */}
      <svg width="27" height="12" viewBox="0 0 27 12">
        <rect x="0" y="0.5" width="23" height="11" rx="2" stroke="#fff" strokeWidth="1" fill="none" />
        <rect x="24" y="3.5" width="2.5" height="5" rx="1" fill="#fff" opacity="0.4" />
        <rect x="1.5" y="2" width="20" height="8" rx="1" fill="#32d74b" />
      </svg>
    </div>
  </div>
);

// ─── Typing overlay ───
const TypingOverlay: React.FC<{
  typed: string;
  cursorVisible: boolean;
}> = ({ typed, cursorVisible }) => {
  const frame = useCurrentFrame();
  const cursorOpacity = cursorVisible ? (Math.floor(frame / 18) % 2 === 0 ? 0.85 : 0.5) : 0;
  const lineH = Math.round(TERMINAL_FONT * 1.4);
  const charW = TERMINAL_FONT * 0.62;

  return (
    <div
      style={{
        position: 'absolute',
        top: TERMINAL_TOP,
        left: TERMINAL_LEFT,
        right: TERMINAL_LEFT,
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: TERMINAL_FONT,
        lineHeight: `${lineH}px`,
        zIndex: 10,
      }}
    >
      <span style={{ color: '#339af0', fontWeight: 700 }}>{'❯ '}</span>
      <span style={{ color: '#e0e0e0' }}>{typed}</span>
      <span
        style={{
          display: 'inline-block',
          width: charW,
          height: lineH * 0.82,
          background: `rgba(224, 224, 224, ${cursorOpacity})`,
          verticalAlign: 'text-bottom',
          marginLeft: 1,
        }}
      />
    </div>
  );
};

// ─── Single phone: iPhone 17 Pro + Claude Code header + typing + keyboard ───
const MobileCodeman: React.FC<{
  typed: string;
  cursorVisible: boolean;
  activeKey?: string;
  pressAge?: number;
  showKeyboard?: boolean;
  noAnimation?: boolean;
  showPromo?: boolean;
}> = ({ typed, cursorVisible, activeKey, pressAge, showKeyboard = true, noAnimation, showPromo }) => (
  <IPhone17ProFrame noAnimation={noAnimation}>
    <div
      style={{ width: SCREEN_W, height: SCREEN_H, position: 'relative', overflow: 'hidden', background: '#0d0d0d' }}
    >
      {/* iOS status bar in the safe area */}
      <IOSStatusBar />

      {/* Claude Code header from screenshot (tabs + session info) */}
      <div
        style={{
          position: 'absolute',
          top: SAFE_AREA_TOP,
          left: 0,
          right: 0,
          height: HEADER_H,
          overflow: 'hidden',
          zIndex: 5,
        }}
      >
        <Img
          src={staticFile('mobile-claude.png')}
          style={{
            width: SCREEN_W,
            objectFit: 'cover',
            objectPosition: 'top left',
          }}
        />
        {/* Fade to terminal background */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 30,
            background: 'linear-gradient(transparent, #0d0d0d)',
          }}
        />
      </div>

      {/* Dark mask: hides screenshot text below Claude Code info (e.g. "Try edit...") */}
      <div
        style={{
          position: 'absolute',
          top: SAFE_AREA_TOP + 95,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 8,
        }}
      >
        {/* Smooth gradient blend from screenshot into dark terminal */}
        <div
          style={{
            height: 18,
            background: 'linear-gradient(transparent, #0d0d0d)',
          }}
        />
        <div style={{ flex: 1, background: '#0d0d0d' }} />
      </div>

      {/* Typing animation */}
      <TypingOverlay typed={typed} cursorVisible={cursorVisible} />

      {/* Codeman toolbar from screenshot (/init, /clear, /compact, Run, Run Shell, voice) */}
      <div
        style={{
          position: 'absolute',
          bottom: 232,
          left: 0,
          right: 0,
          height: TOOLBAR_H,
          overflow: 'hidden',
          zIndex: 15,
        }}
      >
        {/* Gradient blend at top */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 18,
            background: 'linear-gradient(#0d0d0d, transparent)',
            zIndex: 1,
          }}
        />
        <Img
          src={staticFile('mobile-claude.png')}
          style={{
            width: SCREEN_W,
            position: 'absolute',
            bottom: 0,
          }}
        />
      </div>

      {/* Promo cards between text and toolbar (left phone only) */}
      {showPromo && <PromoBanners />}

      {/* iOS keyboard at bottom */}
      {showKeyboard && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20 }}>
          <IOSKeyboard activeKey={activeKey} pressAge={pressAge} />
        </div>
      )}
    </div>
  </IPhone17ProFrame>
);

// ─── Label above phone (prominent header) ───
const PhoneLabel: React.FC<{
  title: string;
  detail: string;
  dotColor: string;
  detailColor: string;
}> = ({ title, detail, dotColor, detailColor }) => (
  <div style={{ textAlign: 'center', marginBottom: 16 }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        fontSize: 28,
        fontWeight: 700,
        fontFamily: fonts.ui,
        color: '#fff',
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: `0 0 12px ${dotColor}`,
        }}
      />
      {title}
    </div>
    <div style={{ fontSize: 16, fontFamily: fonts.mono, color: detailColor, marginTop: 6, opacity: 0.9 }}>
      {detail}
    </div>
  </div>
);

// ─── Promo banners (inside left phone, between text and keyboard) ───
const PromoBanners: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      bottom: 332,
      left: 8,
      right: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      zIndex: 15,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <svg width="30" height="30" viewBox="0 0 16 16" fill="#ccc" style={{ flexShrink: 0 }}>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.ui, color: '#e0e0e0' }}>Codeman</div>
        <div style={{ fontSize: 12, fontFamily: fonts.mono, color: '#888' }}>github.com/Ark0N/Codeman</div>
      </div>
    </div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <svg width="30" height="30" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
        <rect width="16" height="16" rx="2" fill="#cb3837" />
        <path d="M3 3h10v10H8V5H5v8H3z" fill="#fff" />
      </svg>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.ui, color: '#e0e0e0' }}>xterm-zerolag-input</div>
        <div style={{ fontSize: 12, fontFamily: fonts.mono, color: '#888' }}>npmjs.com/package/xterm-zerolag-input</div>
      </div>
    </div>
  </div>
);

// ─── Title scene ───
const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame, fps, config: { damping: 15, stiffness: 80 } });
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const subtitleOpacity = interpolate(frame, [15, 35], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: colors.bg.dark, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', transform: `scale(${titleScale})` }}>
        <div
          style={{
            fontSize: 80,
            fontWeight: 700,
            fontFamily: fonts.ui,
            color: '#fff',
            opacity: titleOpacity,
            letterSpacing: -1.5,
          }}
        >
          Zerolag Input
        </div>
        <div
          style={{
            fontSize: 30,
            fontFamily: fonts.ui,
            color: colors.text.dim,
            opacity: subtitleOpacity,
            marginTop: 16,
          }}
        >
          Local echo for remote terminal sessions
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Outro ───
const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: colors.bg.dark, justifyContent: 'center', alignItems: 'center', opacity }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, fontWeight: 700, fontFamily: fonts.ui, color: '#fff' }}>Codeman</div>
        <div style={{ fontSize: 26, fontFamily: fonts.ui, color: colors.accent.green, marginTop: 10 }}>
          Zero-latency mobile input
        </div>
        <div style={{ fontSize: 16, fontFamily: fonts.mono, color: colors.text.muted, marginTop: 20 }}>
          npm i xterm-zerolag-input
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Typing demo scene ───
const TypingDemo: React.FC = () => {
  const frame = useCurrentFrame();

  const laggyTyped = computeVisibleText(frame, true);
  const zerolagTyped = computeVisibleText(frame, false);

  let activeKey: string | undefined;
  let pressAge = 99;
  for (let i = TYPING_SCHEDULE.length - 1; i >= 0; i--) {
    const ev = TYPING_SCHEDULE[i];
    if (frame >= ev.frame && frame < ev.frame + 5) {
      activeKey = ev.char;
      pressAge = frame - ev.frame;
      break;
    }
  }

  return (
    <AbsoluteFill style={{ background: colors.bg.dark, justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          display: 'flex',
          gap: 50,
          alignItems: 'flex-start',
          transform: `scale(${PHONE_SCALE})`,
          transformOrigin: 'center center',
        }}
      >
        <div>
          <PhoneLabel
            title="With Zerolag"
            detail="0ms local echo"
            dotColor={colors.accent.green}
            detailColor={colors.accent.green}
          />
          <MobileCodeman typed={zerolagTyped} cursorVisible activeKey={activeKey} pressAge={pressAge} noAnimation showPromo />
        </div>
        <div>
          <PhoneLabel
            title="Without Zerolag"
            detail="600ms–2.7s server echo"
            dotColor={colors.accent.red}
            detailColor={colors.accent.red}
          />
          <MobileCodeman typed={laggyTyped} cursorVisible activeKey={activeKey} pressAge={pressAge} noAnimation />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Phones entrance ───
const PanelsEntrance: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 15, stiffness: 80 } });
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: colors.bg.dark,
        justifyContent: 'center',
        alignItems: 'center',
        opacity,
        transform: `scale(${scale * PHONE_SCALE})`,
      }}
    >
      <div style={{ display: 'flex', gap: 50, alignItems: 'flex-start' }}>
        <div>
          <PhoneLabel
            title="With Zerolag"
            detail="0ms local echo"
            dotColor={colors.accent.green}
            detailColor={colors.accent.green}
          />
          <MobileCodeman typed="" cursorVisible noAnimation />
        </div>
        <div>
          <PhoneLabel
            title="Without Zerolag"
            detail="600ms–2.7s server echo"
            dotColor={colors.accent.red}
            detailColor={colors.accent.red}
          />
          <MobileCodeman typed="" cursorVisible noAnimation />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Main composition ───
export const ZerolagDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg.dark }}>
      <Sequence from={TITLE_START} durationInFrames={TITLE_DUR}>
        <TitleScene />
      </Sequence>
      <Sequence from={PHONES_START} durationInFrames={PHONES_DUR} premountFor={5}>
        <PanelsEntrance />
      </Sequence>
      <Sequence from={TYPING_START} durationInFrames={TYPING_DUR + HOLD_DUR} premountFor={5}>
        <TypingDemo />
      </Sequence>
      <Sequence from={OUTRO_START} durationInFrames={OUTRO_DUR} premountFor={5}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};
