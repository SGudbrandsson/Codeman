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
const TYPING_DUR = 468;
const HOLD_DUR = 60;
const OUTRO_DUR = 45;

const TITLE_START = 0;
const PHONES_START = TITLE_DUR; // 60
const TYPING_START = PHONES_START + PHONES_DUR; // 90
const HOLD_START = TYPING_START + TYPING_DUR; // 558
const OUTRO_START = HOLD_START + HOLD_DUR; // 618

export const ZEROLAG_TOTAL_FRAMES = OUTRO_START + OUTRO_DUR; // 663

// ─── iPhone 17 Pro safe area ───
const SAFE_AREA_TOP = 59; // Below Dynamic Island
const PHONE_SCALE = 1.12; // Scale up to fill more of the frame

// The Codeman screenshot starts content at y=0 (the session tab).
// On a real device it would sit below the safe area, so we offset it.
const SCREENSHOT_Y_OFFSET = SAFE_AREA_TOP;

// Terminal typing overlay position (relative to screenshot top)
// Session tab is ~44px, then terminal starts. Adding safe area offset:
const TERMINAL_TOP = SAFE_AREA_TOP + 52;
const TERMINAL_LEFT = 14;
const TERMINAL_FONT = 22; // Large for video readability

// ─── Typing schedule (with typo + backspace correction) ───
const CORRECT_TEXT = 'fix the auth bug in the login flow';
const FRAME_GAP = 12; // ~400ms between keystrokes
const TYPO_INDEX = 28; // After "logi", type "m" instead of "n"

// Remote connection lag: 600ms-1.2s+ per char (18-36+ frames)
const LAGGY_DELAYS = [
  24, 30, 36, 32, 26, 22, 34, 28, 38, 20, 30, 24, 32, 26, 36, 22,
  30, 24, 32, 28, 34, 26, 30, 22, 28, 36, 24, 30, 32, 26, 34, 28, 24, 30,
  26, 32, 28, 34,
];

type KeyAction = { frame: number; action: 'type' | 'backspace'; char: string; lagDelay: number };

const buildSchedule = (): KeyAction[] => {
  const actions: KeyAction[] = [];
  let idx = 0;
  const lag = (i: number) => LAGGY_DELAYS[i % LAGGY_DELAYS.length];

  // Type correctly up to typo point: "fix the auth bug in the logi"
  for (let i = 0; i < TYPO_INDEX; i++) {
    actions.push({ frame: idx * FRAME_GAP, action: 'type', char: CORRECT_TEXT[i], lagDelay: lag(idx) });
    idx++;
  }

  // Typo: type "m" instead of "n"
  actions.push({ frame: idx * FRAME_GAP, action: 'type', char: 'm', lagDelay: lag(idx) });
  idx++;

  // Backspace to fix it
  actions.push({ frame: idx * FRAME_GAP, action: 'backspace', char: '⌫', lagDelay: lag(idx) });
  idx++;

  // Type correct remaining: "n flow"
  for (let i = TYPO_INDEX; i < CORRECT_TEXT.length; i++) {
    actions.push({ frame: idx * FRAME_GAP, action: 'type', char: CORRECT_TEXT[i], lagDelay: lag(idx) });
    idx++;
  }

  return actions;
};

const TYPING_SCHEDULE = buildSchedule();

/** Replay actions in order up to current frame, computing the visible text buffer */
const computeVisibleText = (frame: number, withLag: boolean): string => {
  let buffer = '';
  for (const a of TYPING_SCHEDULE) {
    const threshold = withLag ? a.frame + a.lagDelay : a.frame;
    if (frame < threshold) break; // TCP-ordered: stop at first unresolved
    if (a.action === 'backspace') buffer = buffer.slice(0, -1);
    else buffer += a.char;
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
        <path d="M4.5 8.5C5.5 7.2 6.7 6.5 8 6.5s2.5.7 3.5 2" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M1.5 5.5C3.5 3 5.7 1.5 8 1.5s4.5 1.5 6.5 4" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
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
  overlayChars?: { char: string; confirmed: boolean }[];
  cursorVisible: boolean;
}> = ({ typed, overlayChars, cursorVisible }) => {
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
      {overlayChars
        ? overlayChars.map((oc, i) => (
            <span key={i} style={{ color: oc.confirmed ? '#e0e0e0' : '#666' }}>
              {oc.char}
            </span>
          ))
        : <span style={{ color: '#e0e0e0' }}>{typed}</span>}
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

// ─── Single phone: iPhone 17 Pro + real screenshot + typing + keyboard ───
const MobileCodeman: React.FC<{
  typed: string;
  overlayChars?: { char: string; confirmed: boolean }[];
  cursorVisible: boolean;
  activeKey?: string;
  pressAge?: number;
  showKeyboard?: boolean;
  noAnimation?: boolean;
}> = ({ typed, overlayChars, cursorVisible, activeKey, pressAge, showKeyboard = true, noAnimation }) => (
  <IPhone17ProFrame noAnimation={noAnimation}>
    <div style={{ width: SCREEN_W, height: SCREEN_H, position: 'relative', overflow: 'hidden', background: '#000' }}>
      {/* Real Codeman mobile screenshot, pushed down by safe area */}
      <Img
        src={staticFile('mobile-claude.png')}
        style={{
          width: SCREEN_W,
          height: SCREEN_H - SCREENSHOT_Y_OFFSET,
          objectFit: 'cover',
          objectPosition: 'top',
          position: 'absolute',
          top: SCREENSHOT_Y_OFFSET,
          left: 0,
        }}
      />

      {/* iOS status bar in the safe area */}
      <IOSStatusBar />

      {/* Typing animation */}
      <TypingOverlay typed={typed} overlayChars={overlayChars} cursorVisible={cursorVisible} />

      {/* iOS keyboard at bottom */}
      {showKeyboard && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20 }}>
          <IOSKeyboard activeKey={activeKey} pressAge={pressAge} />
        </div>
      )}
    </div>
  </IPhone17ProFrame>
);

// ─── Label beneath phone ───
const PhoneLabel: React.FC<{
  title: string;
  detail: string;
  dotColor: string;
  detailColor: string;
}> = ({ title, detail, dotColor, detailColor }) => (
  <div style={{ textAlign: 'center', marginTop: 20 }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        fontSize: 24,
        fontWeight: 600,
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
          <MobileCodeman typed={zerolagTyped} cursorVisible activeKey={activeKey} pressAge={pressAge} noAnimation />
          <PhoneLabel title="With Zerolag" detail="0ms delay" dotColor={colors.accent.green} detailColor={colors.accent.green} />
        </div>
        <div>
          <MobileCodeman typed={laggyTyped} cursorVisible activeKey={activeKey} pressAge={pressAge} noAnimation />
          <PhoneLabel title="Without Zerolag" detail="600ms–1.2s delay" dotColor={colors.accent.red} detailColor={colors.accent.red} />
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
          <MobileCodeman typed="" cursorVisible noAnimation />
          <PhoneLabel title="With Zerolag" detail="0ms delay" dotColor={colors.accent.green} detailColor={colors.accent.green} />
        </div>
        <div>
          <MobileCodeman typed="" cursorVisible noAnimation />
          <PhoneLabel title="Without Zerolag" detail="600ms–1.2s delay" dotColor={colors.accent.red} detailColor={colors.accent.red} />
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
