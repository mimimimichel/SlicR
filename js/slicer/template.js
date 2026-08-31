/**
 * Orca Web Slicer — the little language custom G-code is written in.
 *
 * Start and end scripts are not just text with holes in them. Real profiles
 * need to say things like "only wait for the chamber if this machine has one"
 * or "park at the back unless the bed is short", and a plain find-and-replace
 * cannot express a condition. This is the same shape of language Orca and
 * PrusaSlicer use:
 *
 *   M104 S{first_layer_temp}
 *   {if chamber_temp > 0}M191 S{chamber_temp}{endif}
 *   G0 X{bed_x / 2} Y{min(bed_y - 10, 200)}
 *
 * Everything is evaluated, never executed: there is no eval, no property
 * access, and no way to reach anything but the values handed in. A placeholder
 * naming something unknown is left exactly as written rather than being turned
 * into the word "undefined" in a file that drives a machine.
 */
(function (root) {
  'use strict';

  var FUNCTIONS = {
    min: Math.min, max: Math.max, abs: Math.abs,
    round: function (v, places) {
      var f = Math.pow(10, places || 0);
      return Math.round(v * f) / f;
    },
    floor: Math.floor, ceil: Math.ceil, int: function (v) { return v | 0; }
  };

  // --- tokeniser -----------------------------------------------------------

  var TOKEN = /\s*(>=|<=|==|!=|&&|\|\||[-+*/%(),?:<>!]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*')/g;

  function tokenise(src) {
    var out = [], re = new RegExp(TOKEN.source, 'g'), m, at = 0;
    while ((m = re.exec(src))) {
      if (m.index !== at) return null;             // something we cannot read
      at = re.lastIndex;
      out.push(m[1]);
    }
    return at === src.length ? out : (src.slice(at).trim() === '' ? out : null);
  }

  // --- precedence-climbing parser and evaluator ----------------------------

  var BINARY = {
    '||': 1, '&&': 2,
    '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
    '+': 5, '-': 5, '*': 6, '/': 6, '%': 6
  };

  function Parser(tokens, vars) {
    this.t = tokens;
    this.i = 0;
    this.vars = vars;
  }
  Parser.prototype.peek = function () { return this.t[this.i]; };
  Parser.prototype.next = function () { return this.t[this.i++]; };
  Parser.prototype.expect = function (tok) {
    if (this.next() !== tok) throw new Error('expected ' + tok);
  };

  Parser.prototype.primary = function () {
    var tok = this.next();
    if (tok === undefined) throw new Error('unexpected end');
    if (tok === '(') {
      var inner = this.ternary();
      this.expect(')');
      return inner;
    }
    if (tok === '-') return -this.primary();
    if (tok === '+') return this.primary();
    if (tok === '!') return !truthy(this.primary());
    if (/^["']/.test(tok)) return tok.slice(1, -1);
    if (/^\d/.test(tok)) return parseFloat(tok);
    if (/^[A-Za-z_]/.test(tok)) {
      if (this.peek() === '(') {
        this.next();
        var args = [];
        if (this.peek() !== ')') {
          for (;;) {
            args.push(this.ternary());
            if (this.peek() !== ',') break;
            this.next();
          }
        }
        this.expect(')');
        var fn = FUNCTIONS[tok];
        if (!fn) throw new Error('no such function ' + tok);
        return fn.apply(null, args);
      }
      if (tok === 'true') return true;
      if (tok === 'false') return false;
      if (!Object.prototype.hasOwnProperty.call(this.vars, tok)) {
        throw new Error('unknown value ' + tok);
      }
      return this.vars[tok];
    }
    throw new Error('unexpected ' + tok);
  };

  Parser.prototype.binary = function (minPrec) {
    var left = this.primary();
    for (;;) {
      var op = this.peek();
      var prec = BINARY[op];
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      var right = this.binary(prec + 1);
      left = apply(op, left, right);
    }
  };

  Parser.prototype.ternary = function () {
    var cond = this.binary(1);
    if (this.peek() !== '?') return cond;
    this.next();
    var yes = this.ternary();
    this.expect(':');
    var no = this.ternary();
    return truthy(cond) ? yes : no;
  };

  function truthy(v) { return !(v === false || v === 0 || v === '' || v == null); }

  function apply(op, a, b) {
    switch (op) {
      case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? 0 : a / b;
      case '%': return b === 0 ? 0 : a % b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '==': return a === b;
      case '!=': return a !== b;
      case '&&': return truthy(a) && truthy(b);
      case '||': return truthy(a) ? a : b;
    }
    throw new Error('unknown operator ' + op);
  }

  function evaluate(src, vars) {
    var tokens = tokenise(src);
    if (!tokens || !tokens.length) throw new Error('empty expression');
    var p = new Parser(tokens, vars);
    var value = p.ternary();
    if (p.i !== tokens.length) throw new Error('trailing input');
    return value;
  }

  // --- rendering -----------------------------------------------------------

  /** Split into literal runs and {…} placeholders, respecting quotes. */
  function chunks(text) {
    var out = [], buf = '', i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch !== '{') { buf += ch; i++; continue; }
      var j = i + 1, quote = null, depth = 1;
      while (j < text.length) {
        var c = text[j];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        j++;
      }
      if (j >= text.length) { buf += text.slice(i); break; }   // unclosed: literal
      if (buf) { out.push({ text: buf }); buf = ''; }
      out.push({ code: text.slice(i + 1, j), raw: text.slice(i, j + 1) });
      i = j + 1;
    }
    if (buf) out.push({ text: buf });
    return out;
  }

  function format(value) {
    if (typeof value === 'number') {
      if (!isFinite(value)) return '0';
      return String(Math.round(value * 1e6) / 1e6);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    return String(value);
  }

  /**
   * Render `text` against `vars`. Unresolvable placeholders are left as they
   * were written, so a typo shows up in the file as a typo rather than as a
   * plausible-looking number.
   */
  function render(text, vars) {
    if (text == null) return '';
    var parts = chunks(String(text));
    // A stack of "is this branch live", plus whether any branch of the current
    // if has already been taken.
    var live = [true], taken = [true];
    var out = '';

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var emitting = live[live.length - 1];

      if (part.text !== undefined) {
        if (emitting) out += part.text;
        continue;
      }

      var code = part.code.trim();
      var ifMatch = /^if\s+([\s\S]+)$/.exec(code);
      var elsifMatch = /^els(?:e\s*)?if\s+([\s\S]+)$/.exec(code);

      if (ifMatch && !elsifMatch) {
        var on = emitting && safeTruthy(ifMatch[1], vars);
        live.push(on);
        taken.push(on);
        continue;
      }
      if (elsifMatch) {
        if (live.length < 2) continue;             // stray: ignore
        var parent = live[live.length - 2];
        var already = taken[taken.length - 1];
        var use = parent && !already && safeTruthy(elsifMatch[1], vars);
        live[live.length - 1] = use;
        taken[taken.length - 1] = already || use;
        continue;
      }
      if (code === 'else') {
        if (live.length < 2) continue;
        var up = live[live.length - 2];
        live[live.length - 1] = up && !taken[taken.length - 1];
        taken[taken.length - 1] = true;
        continue;
      }
      if (code === 'endif') {
        if (live.length > 1) { live.pop(); taken.pop(); }
        continue;
      }

      if (!emitting) continue;
      try {
        out += format(evaluate(code, vars));
      } catch (err) {
        out += part.raw;                           // leave it exactly as written
      }
    }
    return out;
  }

  function safeTruthy(expr, vars) {
    try { return truthy(evaluate(expr, vars)); }
    catch (err) { return false; }
  }

  root.OrcaTemplate = { render: render, evaluate: evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaTemplate;
})(typeof globalThis !== 'undefined' ? globalThis : self);
