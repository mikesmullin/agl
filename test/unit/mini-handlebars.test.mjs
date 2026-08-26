import { describe, expect, test } from 'bun:test';
import { compile, applyLocals } from '../../src/lib/mini-handlebars.mjs';

const render = (src, data) => compile(src)(data);

describe('simple expressions', () => {
  test('substitutes a path', () => {
    expect(render('Handlebars {{doesWhat}}', { doesWhat: 'rocks!' })).toBe(
      'Handlebars rocks!',
    );
  });

  test('dot paths', () => {
    expect(
      render('{{person.firstname}} {{person.lastname}}', {
        person: { firstname: 'Yehuda', lastname: 'Katz' },
      }),
    ).toBe('Yehuda Katz');
  });

  test('missing paths are empty', () => {
    expect(render('X{{missing}}Y', {})).toBe('XY');
  });

  test('does not HTML-escape', () => {
    expect(render('{{x}}', { x: 'a <b> & c' })).toBe('a <b> & c');
    expect(render('{{{x}}}', { x: 'a <b> & c' })).toBe('a <b> & c');
  });

  test('false and null stringify empty; 0 and true do not', () => {
    expect(render('{{a}}', { a: false })).toBe('');
    expect(render('{{a}}', { a: null })).toBe('');
    expect(render('{{a}}', { a: 0 })).toBe('0');
    expect(render('{{a}}', { a: true })).toBe('true');
  });

  test('literals in mustaches', () => {
    expect(render('{{true}}', {})).toBe('true');
    expect(render('{{false}}', {})).toBe('');
    expect(render('{{0}}', {})).toBe('0');
  });
});

describe('with', () => {
  test('changes context', () => {
    expect(
      render('{{#with person}}{{firstname}} {{lastname}}{{/with}}', {
        person: { firstname: 'Yehuda', lastname: 'Katz' },
      }),
    ).toBe('Yehuda Katz');
  });

  test('else when empty', () => {
    expect(
      render('{{#with person}}{{name}}{{else}}nobody{{/with}}', { person: null }),
    ).toBe('nobody');
  });

  test('../ reaches parent', () => {
    expect(
      render('{{#with person}}{{../title}}: {{name}}{{/with}}', {
        title: 'Mr',
        person: { name: 'Ada' },
      }),
    ).toBe('Mr: Ada');
  });
});

describe('each', () => {
  test('iterates arrays with this', () => {
    expect(
      render('{{#each people}}{{this}}{{/each}}', { people: ['Yehuda', 'Alan'] }),
    ).toBe('YehudaAlan');
  });

  test('iterates object fields with this', () => {
    expect(
      render('{{#each person}}{{this}}{{/each}}', {
        person: { firstname: 'Yehuda', lastname: 'Katz' },
      }),
    ).toBe('YehudaKatz');
  });

  test('else when empty', () => {
    expect(
      render('{{#each people}}{{this}}{{else}}none{{/each}}', { people: [] }),
    ).toBe('none');
  });

  test('@index @first @last', () => {
    expect(
      render(
        '{{#each arr}}{{@index}}:{{this}}{{#if @first}}!{{/if}}{{#if @last}}?{{/if}} {{/each}}',
        { arr: ['a', 'b', 'c'] },
      ),
    ).toBe('0:a! 1:b 2:c? ');
  });

  test('@key on objects', () => {
    expect(
      render('{{#each obj}}{{@key}}={{this}};{{/each}}', {
        obj: { a: 1, b: 2 },
      }),
    ).toBe('a=1;b=2;');
  });

  test('../ from each', () => {
    expect(
      render('{{#each comments}}{{../permalink}} {{title}} {{/each}}', {
        permalink: '/p',
        comments: [{ title: 'one' }, { title: 'two' }],
      }),
    ).toBe('/p one /p two ');
  });

  test('../ inside if inside each still parent of each', () => {
    expect(
      render(
        '{{#each comments}}{{#if title}}{{../permalink}}{{/if}}{{/each}}',
        { permalink: '/p', comments: [{ title: 'x' }] },
      ),
    ).toBe('/p');
  });

  test('@../index from nested each', () => {
    expect(
      render(
        '{{#each outer}}{{#each inner}}{{@../index}}:{{this}} {{/each}}{{/each}}',
        { outer: [{ inner: ['a', 'b'] }, { inner: ['c'] }] },
      ),
    ).toBe('0:a 0:b 1:c ');
  });

  test('this.[0] literal segment', () => {
    expect(
      render('{{#each tuple}}{{this.[0]}} {{this.[1]}}{{/each}}', {
        tuple: [['a', 'b']],
      }),
    ).toBe('a b');
  });
});

describe('conditionals', () => {
  test('#if truthy', () => {
    expect(render('{{#if author}}yes{{/if}}', { author: { name: 'Y' } })).toBe(
      'yes',
    );
  });

  test('#if falsy skips; empty array is falsy', () => {
    expect(render('{{#if author}}yes{{/if}}', {})).toBe('');
    expect(render('{{#if items}}yes{{/if}}', { items: [] })).toBe('');
    expect(render('{{#if n}}yes{{/if}}', { n: 0 })).toBe('');
  });

  test('#if else', () => {
    expect(render('{{#if a}}A{{else}}B{{/if}}', {})).toBe('B');
    expect(render('{{#if a}}A{{else}}B{{/if}}', { a: 1 })).toBe('A');
  });

  test('#if else if else', () => {
    const src = '{{#if a}}A{{else if b}}B{{else}}C{{/if}}';
    expect(render(src, { a: 1 })).toBe('A');
    expect(render(src, { b: 1 })).toBe('B');
    expect(render(src, {})).toBe('C');
  });

  test('#unless', () => {
    expect(render('{{#unless license}}warn{{/unless}}', {})).toBe('warn');
    expect(render('{{#unless license}}warn{{/unless}}', { license: 'MIT' })).toBe(
      '',
    );
  });

  test('if does not change context', () => {
    expect(render('{{#if name}}{{name}}{{/if}}', { name: 'Ada' })).toBe('Ada');
  });
});

describe('whitespace control', () => {
  test('~ strips adjacent whitespace', () => {
    expect(
      render('{{#each nav~}}\n  <a href="{{url}}">\n    {{~#if test}}\n      {{~title}}\n    {{~else~}}\n      Empty\n    {{~/if~}}\n  </a>\n{{~/each}}', {
        nav: [
          { url: 'foo', test: true, title: 'bar' },
          { url: 'bar' },
        ],
      }),
    ).toBe('<a href="foo">bar</a><a href="bar">Empty</a>');
  });

  test('standalone block tags drop their line', () => {
    expect(render('{{#if ok}}\nbar\n{{/if}}\n', { ok: true })).toBe('bar\n');
  });
});

describe('escaping mustaches', () => {
  test('\\{{...}} is literal', () => {
    expect(render('\\{{escaped}}', { escaped: 'nope' })).toBe('{{escaped}}');
  });

  test('keeps surrounding text', () => {
    expect(render('x\\{{y}}z', {})).toBe('x{{y}}z');
  });
});

describe('errors', () => {
  test('unknown helper', () => {
    expect(() => render('{{#list x}}a{{/list}}', { x: [] })).toThrow(
      /unknown helper/,
    );
  });

  test('unclosed block', () => {
    expect(() => render('{{#if x}}hi', { x: 1 })).toThrow(/unclosed/);
  });
});

describe('applyLocals', () => {
  test('interpolates when locals is a plain object', () => {
    expect(applyLocals('The date is {{date}}', { date: 'Wednesday' })).toBe(
      'The date is Wednesday',
    );
  });

  test('leaves template alone when locals omitted', () => {
    expect(applyLocals('keep {{date}}', undefined)).toBe('keep {{date}}');
    expect(applyLocals('keep {{date}}', null)).toBe('keep {{date}}');
  });

  test('leaves template alone for arrays', () => {
    expect(applyLocals('keep {{date}}', ['x'])).toBe('keep {{date}}');
  });
});
