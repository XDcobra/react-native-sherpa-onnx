import { DownloadError } from '../errors';
import { sourceFetch } from '../fetch';
import type { SourceFetchContext } from '../types';

function makeContext(
  overrides?: Partial<SourceFetchContext>
): SourceFetchContext {
  return {
    sourceId: 'test_source',
    headers: {
      Accept: 'application/json',
    },
    requestPolicy: {
      retries: 0,
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
    ...overrides,
  };
}

describe('sourceFetch', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it('returns response on 200', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const result = await sourceFetch('https://example.invalid', makeContext());

    expect(result.attempt).toBe(0);
    expect(result.response.status).toBe(200);
  });

  it('merges headers and injects Authorization from token', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;
    global.fetch = fetchMock;

    await sourceFetch(
      'https://example.invalid',
      makeContext({
        token: 'abc',
      }),
      {
        headers: {
          'X-Req': '1',
        },
      }
    );

    const mocked = fetchMock as unknown as jest.Mock;
    const init = mocked.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-Req')).toBe('1');
    expect(headers.get('Authorization')).toBe('Bearer abc');
  });

  it('maps 401 to DOWNLOAD_SOURCE_AUTH_FAILED', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 401 }) as typeof fetch;

    await expect(
      sourceFetch('https://example.invalid', makeContext())
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_SOURCE_AUTH_FAILED',
    });
  });

  it('does not retry 429 when retries=0', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 429 }) as typeof fetch;
    global.fetch = fetchMock;

    await expect(
      sourceFetch('https://example.invalid', makeContext())
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_HTTP_STATUS',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient 429 when retries>0', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 429 }) as typeof fetch;
    global.fetch = fetchMock;

    await expect(
      sourceFetch(
        'https://example.invalid',
        makeContext({
          requestPolicy: {
            retries: 3,
            initialDelayMs: 0,
            maxDelayMs: 0,
          },
        })
      )
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_HTTP_STATUS',
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps transport failures to DOWNLOAD_NETWORK_FAILED', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('socket hang up')) as typeof fetch;

    await expect(
      sourceFetch('https://example.invalid', makeContext())
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_NETWORK_FAILED',
    });
  });

  it('never includes token in error message', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('connection failed')) as typeof fetch;

    const token = 'secret_token_value';

    await expect(
      sourceFetch(
        'https://example.invalid',
        makeContext({
          token,
        })
      )
    ).rejects.toBeInstanceOf(DownloadError);

    try {
      await sourceFetch(
        'https://example.invalid',
        makeContext({
          token,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(token);
    }
  });
});
