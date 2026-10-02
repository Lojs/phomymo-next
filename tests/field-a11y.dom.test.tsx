// @vitest-environment jsdom
/**
 * Accessibility: a <label for> must point at a labelable control.
 *
 * Field() renders <label htmlFor={id}> where `id` sits on the wrapper <div class="field-control">,
 * not on the <input> inside it. A label pointing at a div is associated with nothing: screen
 * readers cannot announce the field's name, and clicking the label does not focus the input.
 *
 * These tests document the defect. They assert the CORRECT behaviour, so they fail while the
 * defect exists and pass once Field forwards its id to the control.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { Field, NumberInput, Slider, Select, Toggle } from '../src/ui/kit';

beforeEach(() => cleanup());

/** The labelable elements a <label for> is allowed to point at. */
const LABELABLE = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS'];

describe('Field label association', () => {
  it('the label points at a labelable element, not at a wrapper div', () => {
    render(<Field label="Printer name"><input defaultValue="x" /></Field>);
    const label = document.querySelector('label')!;
    const target = document.getElementById(label.getAttribute('for')!);
    expect(target).toBeTruthy();
    expect(
      LABELABLE.includes(target!.tagName),
      `label points at <${target!.tagName.toLowerCase()}>; it must point at a form control`,
    ).toBe(true);
  });

  it('the label can be used to find the input, the way assistive tech does', () => {
    render(<Field label="Printer name"><input defaultValue="x" /></Field>);
    expect(screen.getByLabelText('Printer name')).toBeTruthy();
  });

  it('works for a select control too', () => {
    render(<Field label="Protocol"><select defaultValue="a"><option value="a">a</option></select></Field>);
    expect(screen.getByLabelText('Protocol')).toBeTruthy();
  });

  it('works for a textarea control', () => {
    render(<Field label="Notes"><textarea defaultValue="" /></Field>);
    expect(screen.getByLabelText('Notes')).toBeTruthy();
  });

  it('every field on a real dialog resolves by its label', () => {
    // A representative slice of the printers dialog's fields.
    render(
      <>
        <Field label="ID"><input defaultValue="x" /></Field>
        <Field label="Name"><input defaultValue="y" /></Field>
        <Field label="Width (bytes)"><input defaultValue="72" /></Field>
      </>,
    );
    for (const l of ['ID', 'Name', 'Width (bytes)']) {
      expect(() => screen.getByLabelText(l), `field "${l}" is not reachable by its label`).not.toThrow();
    }
  });
});

describe('Field forwards the id through composite controls', () => {
  // NumberInput and Slider render a wrapper <span> around the real <input>. Before this was
  // fixed, the id landed on the span, so the label pointed at a non-labelable element again —
  // the same defect as the bare-input case, just one level deeper.
  it('a NumberInput inside a Field is reachable by the field label', () => {
    render(<Field label="Width"><NumberInput value={42} onChange={() => {}} /></Field>);
    expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('42');
  });

  it('a Slider inside a Field is reachable by the field label', () => {
    render(<Field label="Rotation"><Slider value={0} min={0} max={359} onChange={() => {}} /></Field>);
    expect(screen.getByLabelText('Rotation')).toBeTruthy();
  });

  it('a Select inside a Field is reachable by the field label', () => {
    render(<Field label="Protocol"><Select value="a" onChange={() => {}}><option value="a">a</option></Select></Field>);
    expect(screen.getByLabelText('Protocol')).toBeTruthy();
  });

  it('a Toggle inside a Field is reachable by the field label', () => {
    render(<Field label="Tape"><Toggle checked={false} onChange={() => {}} label="Tape printer" /></Field>);
    expect(screen.getByLabelText('Tape printer')).toBeTruthy();
  });
});
