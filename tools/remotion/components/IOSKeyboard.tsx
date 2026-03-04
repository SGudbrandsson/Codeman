import React from 'react';
import { fonts } from '../lib/theme';

type IOSKeyboardProps = {
  activeKey?: string;
  /** How many frames since the key was pressed (for highlight decay) */
  pressAge?: number;
};

const ROW_1 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
const ROW_2 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
const ROW_3 = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

const KEY_H = 42;
const KEY_GAP = 6;
const ROW_GAP = 11;
const SIDE_PAD = 3;

const KEYBOARD_BG = '#1c1c1e';
const KEY_BG = '#3a3a3c';
const KEY_BG_ACTIVE = '#636366';
const KEY_TEXT = '#fff';
const SPECIAL_BG = '#2c2c2e';

const Key: React.FC<{
  label: string;
  width: number;
  isActive: boolean;
  pressAge: number;
  fontSize?: number;
}> = ({ label, width, isActive, pressAge, fontSize = 22 }) => {
  // Highlight decays over 4 frames
  const highlightOpacity = isActive && pressAge < 4 ? 1 - pressAge / 4 : 0;
  const bg = highlightOpacity > 0
    ? lerpColor(KEY_BG, KEY_BG_ACTIVE, highlightOpacity)
    : KEY_BG;

  return (
    <div
      style={{
        width,
        height: KEY_H,
        borderRadius: 5,
        background: bg,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        fontSize,
        fontFamily: fonts.ui,
        color: KEY_TEXT,
        fontWeight: 300,
        flexShrink: 0,
      }}
    >
      {label}
    </div>
  );
};

function lerpColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 0xff) * (1 - t) + ((pb >> 16) & 0xff) * t);
  const g = Math.round(((pa >> 8) & 0xff) * (1 - t) + ((pb >> 8) & 0xff) * t);
  const bl = Math.round((pa & 0xff) * (1 - t) + (pb & 0xff) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

export const IOSKeyboard: React.FC<IOSKeyboardProps> = ({ activeKey, pressAge = 99 }) => {
  const isActive = (key: string) =>
    activeKey !== undefined && key.toLowerCase() === activeKey.toLowerCase();
  const age = (key: string) => (isActive(key) ? pressAge : 99);

  // Backspace/delete key highlight
  const deleteHighlight = activeKey === '⌫' && pressAge < 4 ? 1 - pressAge / 4 : 0;
  const deleteBg = deleteHighlight > 0 ? lerpColor(SPECIAL_BG, KEY_BG_ACTIVE, deleteHighlight) : SPECIAL_BG;

  // Key widths: 10 keys + 9 gaps in ~375px row → each key ~33px
  const letterKeyW = 33;
  // Row 2 has 9 keys → same key width but centered with side padding
  // Row 3 has shift + 7 keys + delete

  return (
    <div
      style={{
        width: '100%',
        background: KEYBOARD_BG,
        padding: `${ROW_GAP}px ${SIDE_PAD}px 20px`,
        display: 'flex',
        flexDirection: 'column',
        gap: ROW_GAP,
      }}
    >
      {/* Row 1: q-p */}
      <div style={{ display: 'flex', gap: KEY_GAP, justifyContent: 'center' }}>
        {ROW_1.map((k) => (
          <Key key={k} label={k} width={letterKeyW} isActive={isActive(k)} pressAge={age(k)} />
        ))}
      </div>

      {/* Row 2: a-l */}
      <div style={{ display: 'flex', gap: KEY_GAP, justifyContent: 'center' }}>
        {ROW_2.map((k) => (
          <Key key={k} label={k} width={letterKeyW} isActive={isActive(k)} pressAge={age(k)} />
        ))}
      </div>

      {/* Row 3: shift + z-m + delete */}
      <div style={{ display: 'flex', gap: KEY_GAP, justifyContent: 'center' }}>
        <div
          style={{
            width: 42,
            height: KEY_H,
            borderRadius: 5,
            background: SPECIAL_BG,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
            <path d="M10 2L17 9H13V14H7V9H3L10 2Z" fill="#fff" />
          </svg>
        </div>
        {ROW_3.map((k) => (
          <Key key={k} label={k} width={letterKeyW} isActive={isActive(k)} pressAge={age(k)} />
        ))}
        <div
          style={{
            width: 42,
            height: KEY_H,
            borderRadius: 5,
            background: deleteBg,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <svg width="22" height="16" viewBox="0 0 22 16" fill="none">
            <path d="M7 1L1 8L7 15H21V1H7Z" stroke="#fff" strokeWidth="1.5" fill="none" />
            <path d="M12 5L17 10M17 5L12 10" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* Row 4: 123 / globe / space / return */}
      <div style={{ display: 'flex', gap: KEY_GAP, justifyContent: 'center' }}>
        <div
          style={{
            width: 42,
            height: KEY_H,
            borderRadius: 5,
            background: SPECIAL_BG,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            fontSize: 15,
            fontFamily: fonts.ui,
            color: '#fff',
          }}
        >
          123
        </div>
        <div
          style={{
            width: 38,
            height: KEY_H,
            borderRadius: 5,
            background: SPECIAL_BG,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="#fff" strokeWidth="1.2" />
            <path d="M4 10H16M10 4C7 7 7 13 10 16M10 4C13 7 13 13 10 16" stroke="#fff" strokeWidth="1" />
          </svg>
        </div>
        {/* Space bar */}
        <Key
          label="space"
          width={186}
          isActive={isActive(' ')}
          pressAge={age(' ')}
          fontSize={15}
        />
        <div
          style={{
            width: 88,
            height: KEY_H,
            borderRadius: 5,
            background: SPECIAL_BG,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            fontSize: 15,
            fontFamily: fonts.ui,
            color: '#fff',
          }}
        >
          return
        </div>
      </div>
    </div>
  );
};
