import goldens from '../__fixtures__/uroman-goldens.json';
import { mmsNormalize, romanizeString, uromanRomanizer } from '../uroman';
import { getRomanizer } from '../registry';

describe('uroman romanizer', () => {
  it('is registered as RomanizerId uroman', () => {
    expect(getRomanizer('uroman').id).toBe('uroman');
    expect(uromanRomanizer.id).toBe('uroman');
  });

  it('matches Python uroman string goldens', () => {
    for (const row of goldens) {
      const got = romanizeString(row.text, row.language ?? undefined);
      expect(got).toBe(row.uroman);
    }
  });

  it('applies MMS ASCII normalize after uroman', () => {
    for (const row of goldens) {
      const got = uromanRomanizer.romanize(row.text, row.language ?? undefined);
      expect(got).toBe(row.mmsNormalized);
    }
  });

  it('is language-sensitive for Russian word-initial Е', () => {
    const withRu = uromanRomanizer.romanize('Ельцин', 'ru');
    const without = uromanRomanizer.romanize('Ельцин');
    expect(withRu).toBe('yeltsin');
    expect(without).toBe('eltsin');
    expect(withRu).not.toBe(without);
  });

  it('romanizes Vietnamese tone marks and Đ/đ for MMS FA', () => {
    const vietnamese = goldens.filter((row) => row.language === 'vi');
    expect(vietnamese.length).toBeGreaterThanOrEqual(4);

    expect(uromanRomanizer.romanize('Xin chào Việt Nam', 'vi')).toBe(
      'xin chao viet nam'
    );
    expect(uromanRomanizer.romanize('người', 'vi')).toBe('nguoi');
    expect(uromanRomanizer.romanize('Đặng', 'vi')).toBe('dang');
    expect(uromanRomanizer.romanize('Hà Nội', 'vi')).toBe('ha noi');
    expect(uromanRomanizer.romanize('tiếng Việt', 'vi')).toBe('tieng viet');

    // ISO 639-1 `vi` and 639-3 `vie` should resolve the same path.
    expect(romanizeString('Đặng', 'vi')).toBe(romanizeString('Đặng', 'vie'));
  });

  it('mmsNormalize keeps only a-z, apostrophe, and spaces', () => {
    expect(mmsNormalize("Cafe' 123!")).toBe("cafe'");
    // Diacritics are handled by uroman before normalize; this tests ASCII-only filter.
    expect(mmsNormalize('Cafe')).toBe('cafe');
  });
});
