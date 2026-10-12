// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps the public privacy disclosure reachable and explicit about account visibility.
// ABOUTME: These prose checks guard published promises; source and hosting evidence need review.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const privacy = (): string => read('docs/privacy.md').replace(/\s+/g, ' ');

describe('public privacy disclosure', () => {
  it('covers collection, use, retention and removal for the local record and optional service', () => {
    const text = privacy();
    for (const section of [
      'The local server and its plugins',
      'Installing from npm',
      'The dashboard (optional)',
      'What is collected',
      'What it is used for',
      'How long it is kept',
      'How to remove it',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('rbook/db/rbook.sqlite');
    expect(text).toContain('~/.config/rbook/');
    expect(text).toContain('(migrating-from-cmos.md)');
  });

  it('separates email-address discovery from mail access and intended use from enforcement', () => {
    const text = privacy();
    expect(text).toContain('intended for people working within one organization');
    expect(text).toContain(
      'registration does not require an invitation or verify organization membership'
    );
    expect(text).toContain('email addresses');
    expect(text).toContain('does not connect to or read your email inbox');
    expect(text).toContain('does not include email addresses');
    expect(text).toContain('owners and active collaborators');
    expect(text).toContain('known authorization limitations');
    expect(text).toContain('Diagnostic views can expose sync-request contents across accounts');
    expect(text).toContain('contents of rejected unauthenticated requests');
  });

  it('gives current removal controls without promising deletion from every copy', () => {
    const text = privacy();
    expect(text).toContain('rbook_db(action="purge", confirm=true, expectedSlug="<slug>")');
    expect(text).toContain('rbook_auth(action="logout")');
    expect(text).toContain('rbook_auth(action="revoke", keyId="<id>")');
    expect(text).toContain('Activity and sync logs are kept');
    expect(text).toContain('https://github.com/kneelinghorse/reasonbook/issues');
  });

  it('makes privacy reachable from the landing page, docs, trust page and plugin listing', () => {
    for (const file of [
      'README.md',
      'docs/README.md',
      'docs/trust.md',
      'plugins/reasonbook/README.md',
    ]) {
      expect(read(file)).toMatch(/\[Privacy\]\([^\n)]*privacy\.md\)/);
    }
  });
});
