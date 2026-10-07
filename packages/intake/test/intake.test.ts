import { describe, expect, it } from 'vitest';
import { AI_READER_NOT_APPROVED, LOCAL_READER, parseIntakeReply, readIncident, redactIncidentText, type IntakeReader } from '../src/index.ts';

// Invented exercise text. No real incident.
const TEXT =
  'Overdue hiker, Sam Rivers, age 34, last seen at the Exercise Lake trailhead 51.2034, -115.6120 on Tuesday morning, ' +
  'heading northeast toward Mount Example. Has diabetes and carries insulin. Partner Dr Lee called from 403-555-0142, sam@example.org.';

describe('redactIncidentText', () => {
  const r = redactIncidentText(TEXT);

  it('removes names, contact details and health words, and counts them', () => {
    expect(r.text).not.toMatch(/Sam|Rivers|Lee|555|example\.org|diabetes|insulin/);
    expect(r.removed).toEqual({ phone: 1, email: 1, name: 2, health: 2 });
  });

  it('keeps places, coordinates, ages and direction', () => {
    expect(r.text).toContain('Exercise Lake');
    expect(r.text).toContain('Mount Example');
    expect(r.text).toContain('51.2034, -115.6120');
    expect(r.text).toContain('age 34');
    expect(r.text).toContain('heading northeast');
    expect(r.text).toContain('Tuesday');
  });

  it('treats a lone first name at the start of a sentence as a name', () => {
    expect(redactIncidentText('Priya left at 09:00. She went west.').text).toBe('[person] left at 09:00. She went west.');
  });

  it('removes a phone number at the end of a sentence', () => {
    expect(redactIncidentText('Call 403-555-0142.').text).toBe('Call [contact].');
  });

  it('does not mistake UTM numbers or coordinates for phone numbers', () => {
    expect(redactIncidentText('11U 594123 5677123').removed.phone).toBe(0);
    expect(redactIncidentText('49.0512, -113.9150').removed.phone).toBe(0);
  });

  it('does not change its input', () => {
    const s = 'Sam Rivers 403-555-0142';
    redactIncidentText(s);
    expect(s).toBe('Sam Rivers 403-555-0142');
  });
});

describe('parseIntakeReply', () => {
  it('keeps allowed fields and names everything it drops', () => {
    const r = parseIntakeReply({ lat: 51.2, lng: -115.6, pointKind: 'IPP', travelBearingDeg: 45, subjectCategory: 'hiker', name: 'x', ring50Km: 3 });
    expect(r.fields).toEqual({ lat: 51.2, lng: -115.6, pointKind: 'IPP', travelBearingDeg: 45, subjectCategory: 'hiker' });
    expect(r.discarded.sort()).toEqual(['name', 'ring50Km']);
  });

  it('drops out-of-range values, unknown categories and half a point', () => {
    const r = parseIntakeReply({ lat: 51.2, travelBearingDeg: 400, subjectCategory: 'dementia' });
    expect(r.fields).toEqual({});
    expect(r.discarded.sort()).toEqual(['lat', 'subjectCategory', 'travelBearingDeg']);
  });

  it('reads JSON text, including a fenced block, and refuses anything else', () => {
    expect(parseIntakeReply('```json\n{"pointKind":"LKP"}\n```').fields).toEqual({ pointKind: 'LKP' });
    expect(parseIntakeReply('the IPP is at the lake').discarded).toEqual(['(reply was not JSON)']);
    expect(parseIntakeReply([1, 2]).discarded).toEqual(['(reply was not an object)']);
  });
});

describe('readIncident', () => {
  it('sends only cleaned text to the reader', async () => {
    let seen = '';
    const spy: IntakeReader = { name: 'spy', enabled: true, read: async (t) => ((seen = t), {}) };
    await readIncident(TEXT, spy);
    expect(seen).toBe(redactIncidentText(TEXT).text);
    expect(seen).not.toMatch(/Sam|insulin|555/);
  });

  it('refuses a reader that is switched off, without calling it', async () => {
    await expect(readIncident(TEXT, AI_READER_NOT_APPROVED)).rejects.toThrow(/switched off/);
  });

  it('the local reader finds the point, direction and activity', async () => {
    const r = await readIncident(TEXT, LOCAL_READER);
    expect(r.fields).toEqual({ lat: 51.2034, lng: -115.612, travelBearingDeg: 45, subjectCategory: 'hiker' });
    expect(r.discarded).toEqual([]);
  });

  it('the local reader handles hemisphere letters, a stated kind and a numeric bearing', async () => {
    const r = await readIncident('LKP 51.4100 N, 116.2000 W, bearing 250. Out skiing.', LOCAL_READER);
    expect(r.fields).toEqual({ lat: 51.41, lng: -116.2, pointKind: 'LKP', travelBearingDeg: 250, subjectCategory: 'skier' });
  });
});
