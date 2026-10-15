import { test } from 'node:test';
import { assert, fixture, join, repo, write } from './support/helpers.mjs';
import { validateFrontmatter, validateLocalLinks, validateSkill } from '../dev/validate-skill.mjs';

const skill = (header = 'name: example\ndescription: A useful skill.', body = '# Instructions\n') => `---\n${header}\n---\n${body}`;

test('GIDD skill metadata and local Markdown links are valid', () => {
  const errors = validateSkill(join(repo, '.agents/skills/gidd'));
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('frontmatter accepts YAML multiline text, comments and optional metadata under CRLF', () => {
  const source = skill('name: example # comment\ndescription: >-\n  Prepare tools.\n  Use them for development.\nlicense: MIT\nmetadata:\n  short-description: "Tools: development"');
  const { metadata, body } = validateFrontmatter(source.replaceAll('\n', '\r\n'), 'example');
  assert.equal(metadata.description, 'Prepare tools. Use them for development.');
  assert.equal(metadata.metadata['short-description'], 'Tools: development');
  assert.equal(body, '# Instructions\r\n');
});

test('frontmatter rejects malformed YAML, invalid metadata and unfinished instructions', () => {
  for (const source of [
    '+++\nname = "example"\n+++',
    '---\nname: example',
    skill('name: [unterminated'),
    skill('name: example\nname: example\ndescription: Text'),
    skill('- example'),
    skill('null'),
    skill('name: example'),
    skill('name: Example\ndescription: Text'),
    skill('name: ex--ample\ndescription: Text'),
    skill('name: another\ndescription: Text'),
    skill('name: 123\ndescription: Text'),
    skill('name: example\ndescription: []'),
    skill('name: example\ndescription: "  "'),
    skill(`name: example\ndescription: ${'a'.repeat(1025)}`),
    skill('name: example\ndescription: "<placeholder>"'),
    skill('name: example\ndescription: "[TODO: describe]"'),
    skill('name: example\ndescription: Text\nunknown: true'),
    skill(undefined, '[TODO: Write the instructions.]'),
  ]) assert.throws(() => validateFrontmatter(source, 'example'), undefined, source);
  assert.doesNotThrow(() => validateFrontmatter(skill(undefined, '```md\n[TODO: Example only.]\n```\n`[TODO: Inline example.]`'), 'example'));
});

test('Markdown links resolve from their document and exclude code, remote URLs and anchors', () => {
  const f = fixture();
  try {
    const file = join(f.root, 'references/guide.md');
    write(file, '');
    write(join(f.root, '资源 (一).md'), '# 标题');
    const markdown = [
      '[reference][guide]',
      '[guide]: <../资源 (一).md> "Local title"',
      '![image](../%E8%B5%84%E6%BA%90%20%28%E4%B8%80%29.md#heading)',
      '[nested](../资源\(一\).md)',
      '[web](https://example.com/missing) [anchor](#heading)',
      '[mail](mailto:test@example.com) [relative URL](//example.com/missing)',
      '`[inline example](missing.md)`',
      '~~~md\n[fenced example](missing.md)\n~~~',
      '    [indented example](missing.md)',
    ].join('\n\n');
    // Parentheses and spaces are valid file names; the Markdown parser, rather
    // than a link regex, determines which characters belong to the destination.
    write(join(f.root, '资源(一).md'), '');
    assert.deepEqual(validateLocalLinks(markdown, file), []);
    assert.deepEqual(validateLocalLinks('[bad](missing.md)\n![bad](bad%ZZ.md)', file), [
      'Missing local link: missing.md', 'Invalid local link: bad%ZZ.md',
    ]);
  } finally { f.dispose(); }
});

test('skill validation reports nested document failures with source paths', () => {
  const f = fixture();
  try {
    const directory = join(f.root, 'example');
    write(join(directory, 'SKILL.md'), skill(undefined, '[guide](references/guide.md)'));
    write(join(directory, 'references/guide.md'), '[broken][resource]\n\n[resource]: missing.toml');
    const errors = validateSkill(directory);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(join(directory, 'references/guide.md')));
    assert.match(errors[0], /Missing local link: missing.toml/);
  } finally { f.dispose(); }
});
