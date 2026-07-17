import { describe, expect, it } from 'vitest';
import { MatchAuthority, type AuthoritySink } from '../../src/session/p2p/authority';
import type {
  P2PGamePayload,
  P2PMatchReadyPayload,
  P2PStatusPayload,
} from '../../src/session/p2p/types';
import type { WireMsg } from '../../src/session/p2p/protocol';
import { isValidGameState, sanitizePlayerName } from '../../src/session/p2p/protocol';
import { matchOutcome, playerLabel } from '../../src/session/outcome';
import { DEFAULT_CONFIG, type GameState } from '../../src/engine';

function makeSink() {
  const sent: WireMsg[] = [];
  const status: P2PStatusPayload[] = [];
  const games: P2PGamePayload[] = [];
  const ready: P2PMatchReadyPayload[] = [];
  const errors: string[] = [];
  const rejects: string[] = [];
  const sink: AuthoritySink = {
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    onStatus: (s) => status.push(s),
    onGame: (g) => games.push(g),
    onMatchReady: (m) => ready.push(m),
    onError: (e) => errors.push(e),
    onReject: (r) => rejects.push(r),
  };
  return { sink, sent, status, games, ready, errors, rejects };
}

function link(host: MatchAuthority, guest: MatchAuthority, hostSink: ReturnType<typeof makeSink>, guestSink: ReturnType<typeof makeSink>) {
  // Wire each side's send into the other handleRaw
  hostSink.sink.send = (msg) => {
    hostSink.sent.push(msg);
    guest.handleRaw({ v: 1, ...msg });
    return true;
  };
  guestSink.sink.send = (msg) => {
    guestSink.sent.push(msg);
    host.handleRaw({ v: 1, ...msg });
    return true;
  };
}

describe('MatchAuthority', () => {
  it('host + guest exchange names on HELLO/WELCOME/STATE', () => {
    const hostS = makeSink();
    const guestS = makeSink();
    const host = new MatchAuthority(hostS.sink);
    const guest = new MatchAuthority(guestS.sink);
    link(host, guest, hostS, guestS);

    const h = host.prepareHost({ playerName: 'Ada', seeds: 5 });
    expect(h.localPlayerName).toBe('Ada');
    const g = guest.prepareJoin(h.roomCode, 'Bob');
    expect(g.localPlayerName).toBe('Bob');

    host.onPeerConnected();
    // Host is not match-connected until guest HELLO
    expect(host.isConnected).toBe(false);
    expect(
      host.play({ type: 'move', move: { startPit: 0, direction: 'ccw' } }).error,
    ).toBe('waiting_for_peer');

    guest.onPeerConnected(); // guest HELLO → host WELCOME+STATE

    expect(host.isConnected).toBe(true);
    expect(hostS.ready.length).toBe(1);
    expect(hostS.ready[0]!.localPlayerName).toBe('Ada');
    expect(hostS.ready[0]!.remotePlayerName).toBe('Bob');

    expect(guestS.ready.length).toBe(1);
    expect(guestS.ready[0]!.localPlayerName).toBe('Bob');
    expect(guestS.ready[0]!.remotePlayerName).toBe('Ada');

    // Guest should have a game state with names on payload
    expect(guestS.games.length).toBeGreaterThan(0);
    const last = guestS.games[guestS.games.length - 1]!;
    expect(last.localPlayerName).toBe('Bob');
    expect(last.remotePlayerName).toBe('Ada');
    expect(isValidGameState(last.state)).toBe(true);
  });

  it('rejects illegal guest move and host can play after peer', () => {
    const hostS = makeSink();
    const guestS = makeSink();
    const host = new MatchAuthority(hostS.sink);
    const guest = new MatchAuthority(guestS.sink);
    link(host, guest, hostS, guestS);

    const h = host.prepareHost({ playerName: 'Host' });
    guest.prepareJoin(h.roomCode, 'Guest');
    host.onPeerConnected();
    guest.onPeerConnected();

    // Not guest turn at start (South to move) — blocked locally
    const bad = guest.play({ type: 'move', move: { startPit: 7, direction: 'cw' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('not_your_turn');

    const play = host.play({ type: 'move', move: { startPit: 0, direction: 'ccw' } });
    expect(play.ok).toBe(true);
    expect(play.seq).toBe(2);
    // Guest receives STATE
    expect(guestS.games.some((g) => g.seq === 2)).toBe(true);
  });

  it('sanitizePlayerName falls back to Player', () => {
    expect(sanitizePlayerName('  ')).toBe('Player');
    expect(sanitizePlayerName('  Maya  ')).toBe('Maya');
  });

  it('WELCOME does not clobber a real guest nickname', () => {
    const hostS = makeSink();
    const guestS = makeSink();
    const host = new MatchAuthority(hostS.sink);
    const guest = new MatchAuthority(guestS.sink);
    link(host, guest, hostS, guestS);

    const h = host.prepareHost({ playerName: 'Ada' });
    guest.prepareJoin(h.roomCode, 'Bob');
    host.onPeerConnected();
    guest.onPeerConnected();
    expect(guest.getLocalPlayerName()).toBe('Bob');
    // Host echoes a different guestName on a late welcome-like state name field
    guest.handleRaw({
      v: 1,
      type: 'state',
      seq: 1,
      reason: 'reconnect',
      hostName: 'Ada',
      guestName: 'Player',
      state: host.getSnapshot().state,
      events: [],
    });
    expect(guest.getLocalPlayerName()).toBe('Bob');
  });

  it('GOODBYE marks peer disconnected', () => {
    const hostS = makeSink();
    const guestS = makeSink();
    const host = new MatchAuthority(hostS.sink);
    const guest = new MatchAuthority(guestS.sink);
    link(host, guest, hostS, guestS);

    const h = host.prepareHost({ playerName: 'Ada' });
    guest.prepareJoin(h.roomCode, 'Bob');
    host.onPeerConnected();
    guest.onPeerConnected();

    guest.handleRaw({ v: 1, type: 'goodbye' });
    // Guest received goodbye from "host" via reverse path — simulate host gets goodbye
    host.handleRaw({ v: 1, type: 'goodbye' });
    expect(hostS.status.some((s) => s.status === 'peer_disconnected' || s.status === 'peer_goodbye')).toBe(
      true,
    );
    expect(host.isConnected).toBe(false);
  });

  it('host accepts reconnect HELLO and resyncs same board seq', () => {
    const hostS = makeSink();
    const guestS = makeSink();
    const host = new MatchAuthority(hostS.sink);
    const guest = new MatchAuthority(guestS.sink);
    link(host, guest, hostS, guestS);

    const h = host.prepareHost({ playerName: 'Ada' });
    guest.prepareJoin(h.roomCode, 'Bob');
    host.onPeerConnected();
    guest.onPeerConnected();

    const play = host.play({ type: 'move', move: { startPit: 0, direction: 'ccw' } });
    expect(play.ok).toBe(true);
    const seqAfterMove = play.seq!;

    // Drop
    host.onPeerDisconnected();
    guest.onPeerDisconnected();
    expect(hostS.status.some((s) => s.status === 'peer_disconnected')).toBe(true);

    // Reconnect
    host.onPeerConnected();
    guest.onPeerConnected({ reconnect: true });

    const reconnectStates = guestS.games.filter((g) => g.reason === 'reconnect');
    expect(reconnectStates.length).toBeGreaterThan(0);
    const last = reconnectStates[reconnectStates.length - 1]!;
    expect(last.seq).toBe(seqAfterMove);
    expect(last.remotePlayerName).toBe('Ada');
    expect(last.localPlayerName).toBe('Bob');
  });
});

describe('player labels with names', () => {
  it('shows p2p names in labels and outcome', () => {
    expect(
      playerLabel('S', 'p2p', 'S', { local: 'Ada', remote: 'Bob' }),
    ).toBe('Ada');
    expect(
      playerLabel('N', 'p2p', 'S', { local: 'Ada', remote: 'Bob' }),
    ).toBe('Bob');

    const state: GameState = {
      pits: Array(14).fill(0),
      score: { S: 40, N: 30, E: 0 },
      toMove: 'S',
      sowingsUsedThisTurn: 0,
      protectedMask: Array(14).fill(false),
      resigned: null,
      initialTotal: 70,
      config: { ...DEFAULT_CONFIG },
      quietTurns: 0,
      openingComplete: true,
      roundIndex: 0,
      bank: { S: 0, N: 0, E: 0 },
      seriesOver: false,
    };
    const o = matchOutcome(state, {
      mode: 'p2p',
      humanPlayer: 'S',
      names: { local: 'Ada', remote: 'Bob' },
    });
    expect(o.kind).toBe('decisive');
    if (o.kind === 'decisive') {
      expect(o.title).toBe('Ada wins');
      expect(o.southLabel).toBe('Ada');
      expect(o.northLabel).toBe('Bob');
    }
  });
});
