import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { acceptCompletion, autocompletion, completionKeymap, completionStatus, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { defaultHighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import {
  bestSysmlCompletion,
  sysmlCompletionCandidates,
  sysmlCompletionOptions,
  sysmlMemberCompletionOptions
} from '../../lib/sysml/completion';
import { SYSML_HIGHLIGHT_KEYWORDS } from '../../lib/sysml/lexicon';
import {
  documentRevisionForText,
  type AiTeacherCursorOrigin,
  type AiTeacherEditorFocus,
  type AiTeacherInteractionTarget,
  type AiTeacherSelectionOrigin
} from '../../lib/ai-teacher/envelope';

export interface SysmlCodeMirrorHandle {
  focus: () => void;
  getValue: () => string;
  getContext: () => SysmlEditorContext;
  setValue: (value: string) => void;
  focusRange: (from: number, to?: number, options?: SysmlFocusRangeOptions) => void;
  insertAtCursor: (value: string) => void;
  runBestCompletion: () => boolean;
  copySelection: () => Promise<string>;
  cutSelection: () => Promise<string>;
  pasteFromClipboard: () => Promise<string>;
}

export interface SysmlFocusRangeOptions {
  focusEditor?: boolean;
  highlightNavigation?: boolean;
}

interface SysmlCodeMirrorProps {
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onCursorSymbolChange?: (symbolName: string) => void;
  onEditorContextChange?: (context: SysmlEditorContext) => void;
  onEditorContextMenu?: (context: SysmlEditorContextMenu) => void;
  onReady?: () => void;
}

export interface SysmlEditorPosition {
  offset: number;
  line: number;
  column: number;
}

export interface SysmlEditorContext {
  cursor: SysmlEditorPosition;
  selection: {
    from: SysmlEditorPosition;
    to: SysmlEditorPosition;
    text: string;
    empty: boolean;
  };
  symbolName: string;
  contextState: {
    focus: AiTeacherEditorFocus;
    interactionTarget: AiTeacherInteractionTarget;
    capturedAt: string;
    documentRevision: string;
    cursorOrigin: AiTeacherCursorOrigin;
    selectionOrigin: AiTeacherSelectionOrigin;
    degradedReason: string;
  };
}

export interface SysmlEditorContextMenu {
  x: number;
  y: number;
  symbolName: string;
  selectedText: string;
  hasSelection: boolean;
}

const sysmlLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/[{}()[\];,.]/)) return 'punctuation';
    if (stream.match(/[0-9]+(?:\.[0-9]+)?/)) return 'number';
    const word = stream.match(/[A-Za-z_][A-Za-z0-9_:]*/);
    const token = Array.isArray(word) ? word[0] : '';
    if (token) {
      if (SYSML_HIGHLIGHT_KEYWORDS.has(token)) return 'keyword';
      if (/^[A-Z]/.test(token)) return 'variable-2';
      return 'variable';
    }
    stream.next();
    return null;
  }
});

const setNavigationHighlight = StateEffect.define<{ from: number; to: number } | null>();

const navigationHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlights, transaction) {
    const highlightEffect = transaction.effects.find((effect) => effect.is(setNavigationHighlight));
    if (highlightEffect) {
      const range = highlightEffect.value;
      return range && range.to > range.from
        ? Decoration.set([Decoration.mark({ class: 'cm-navigationHighlight' }).range(range.from, range.to)])
        : Decoration.none;
    }
    if (transaction.docChanged || transaction.selection) return Decoration.none;
    return highlights;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export const SysmlCodeMirror = forwardRef<SysmlCodeMirrorHandle, SysmlCodeMirrorProps>(function SysmlCodeMirror(
  { value, readOnly = false, onChange, onCursorSymbolChange, onEditorContextChange, onEditorContextMenu, onReady },
  ref
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onCursorSymbolChangeRef = useRef(onCursorSymbolChange);
  const onEditorContextChangeRef = useRef(onEditorContextChange);
  const onEditorContextMenuRef = useRef(onEditorContextMenu);
  const onReadyRef = useRef(onReady);
  const hasEverFocusedRef = useRef(false);
  const initialReadOnlyRef = useRef(readOnly);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onCursorSymbolChangeRef.current = onCursorSymbolChange;
    onEditorContextChangeRef.current = onEditorContextChange;
    onEditorContextMenuRef.current = onEditorContextMenu;
    onReadyRef.current = onReady;
  }, [onChange, onCursorSymbolChange, onEditorContextChange, onEditorContextMenu, onReady]);

  const extensions = useMemo(() => [
    sysmlLanguage,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    indentUnit.of('  '),
    lineNumbers(),
    drawSelection(),
    navigationHighlightField,
    history(),
    autocompletion({
      activateOnTyping: true,
      override: [sysmlCompletionSource]
    }),
    keymap.of([
      {
        key: 'Tab',
        run: runTabCompletion,
        shift: indentLess
      },
      ...completionKeymap,
      ...historyKeymap,
      ...defaultKeymap
    ]),
    EditorView.lineWrapping,
    readOnlyCompartment.of(editorReadOnlyExtensions(initialReadOnlyRef.current)),
    EditorView.updateListener.of((update) => {
      mountRef.current?.toggleAttribute(
        'data-navigation-highlight',
        update.state.field(navigationHighlightField).size > 0
      );
      if (update.docChanged) {
        const nextValue = update.state.doc.toString();
        valueRef.current = nextValue;
        onChangeRef.current(nextValue);
      }
      if (update.docChanged || update.selectionSet) {
        const selection = update.state.selection.main;
        const content = update.state.doc.toString();
        onCursorSymbolChangeRef.current?.(symbolAt(content, selection.head));
        onEditorContextChangeRef.current?.(editorContextFromState(
          update.state,
          update.view.hasFocus,
          update.view.hasFocus || hasEverFocusedRef.current ? undefined : 'default'
        ));
      }
    }),
    EditorView.domEventHandlers({
      focus(_event, view) {
        hasEverFocusedRef.current = true;
        onEditorContextChangeRef.current?.(editorContextFromState(view.state, true));
        return false;
      },
      blur(_event, view) {
        onEditorContextChangeRef.current?.(editorContextFromState(view.state, false));
        return false;
      },
      contextmenu(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        const range = wordRangeAt(view.state.doc.toString(), pos);
        const selection = view.state.selection.main;
        const hasExistingSelection = !selection.empty && pos >= selection.from && pos <= selection.to;
        if (range && !hasExistingSelection) {
          view.dispatch({ selection: EditorSelection.range(range.from, range.to) });
        } else if (!hasExistingSelection) {
          view.dispatch({ selection: EditorSelection.cursor(pos) });
        }
        const nextSelection = view.state.selection.main;
        const selectedText = nextSelection.empty ? '' : view.state.doc.sliceString(nextSelection.from, nextSelection.to);
        const symbolName = range?.text || symbolAt(view.state.doc.toString(), nextSelection.head);
        onCursorSymbolChangeRef.current?.(symbolName);
        onEditorContextMenuRef.current?.({
          x: event.clientX,
          y: event.clientY,
          symbolName,
          selectedText,
          hasSelection: hasExistingSelection || Boolean(range)
        });
        view.focus();
        return true;
      }
    })
  ], [readOnlyCompartment]);

  useEffect(() => {
    if (!mountRef.current || viewRef.current) return;
    const view = new EditorView({
      parent: mountRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions
      })
    });
    viewRef.current = view;
    onEditorContextChangeRef.current?.(editorContextFromState(view.state, false, 'default'));
    onReadyRef.current?.();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(editorReadOnlyExtensions(readOnly))
    });
  }, [readOnly, readOnlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue === value) return;
    if (!view.hasFocus) hasEverFocusedRef.current = false;
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: value }
    });
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    getValue() {
      return viewRef.current?.state.doc.toString() || '';
    },
    getContext() {
      const view = viewRef.current;
      return view
        ? editorContextFromState(view.state, view.hasFocus, view.hasFocus || hasEverFocusedRef.current ? undefined : 'default')
        : emptyEditorContext();
    },
    setValue(nextValue: string) {
      const view = viewRef.current;
      if (!view) return;
      const currentValue = view.state.doc.toString();
      const originOverride = view.hasFocus ? undefined : 'default';
      if (originOverride) hasEverFocusedRef.current = false;
      view.dispatch({ changes: { from: 0, to: currentValue.length, insert: nextValue } });
      onEditorContextChangeRef.current?.(editorContextFromState(view.state, view.hasFocus, originOverride));
    },
    focusRange(from: number, to = from, options: SysmlFocusRangeOptions = {}) {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      const start = Math.max(0, Math.min(Number(from || 0), length));
      const end = Math.max(start, Math.min(Number(to || start), length));
      const targetRange = EditorSelection.range(start, end);
      view.dispatch({
        selection: targetRange,
        effects: [
          setNavigationHighlight.of(options.highlightNavigation ? { from: start, to: end } : null),
          EditorView.scrollIntoView(targetRange, { y: 'center', yMargin: 48 })
        ]
      });
      onEditorContextChangeRef.current?.(editorContextFromState(view.state, view.hasFocus));
      if (options.focusEditor !== false) view.focus();
    },
    insertAtCursor(insertValue: string) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: insertValue },
        selection: { anchor: selection.from + insertValue.length }
      });
      view.focus();
    },
    runBestCompletion() {
      const view = viewRef.current;
      return view && !view.state.readOnly ? runTabCompletion(view) : false;
    },
    async copySelection() {
      const view = viewRef.current;
      const selectedText = editorSelectedText(view);
      if (!selectedText) return '';
      await writeClipboardText(selectedText);
      view?.focus();
      return selectedText;
    },
    async cutSelection() {
      const view = viewRef.current;
      const selectedText = editorSelectedText(view);
      if (!view || view.state.readOnly || !selectedText) return '';
      await writeClipboardText(selectedText);
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: '' },
        selection: { anchor: selection.from },
        userEvent: 'delete.cut'
      });
      view.focus();
      return selectedText;
    },
    async pasteFromClipboard() {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return '';
      const text = await readClipboardText();
      if (!text) return '';
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
        userEvent: 'input.paste'
      });
      view.focus();
      return text;
    }
  }), []);

  return (
    <div
      ref={mountRef}
      className="codeEditorMount phase3CodeMirror"
      data-editor
      data-code-editor-ready="true"
      data-read-only={readOnly ? 'true' : 'false'}
    />
  );
});

function editorReadOnlyExtensions(readOnly: boolean) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly)
  ];
}

function emptyEditorContext(): SysmlEditorContext {
  return {
    cursor: { offset: 0, line: 1, column: 1 },
    selection: {
      from: { offset: 0, line: 1, column: 1 },
      to: { offset: 0, line: 1, column: 1 },
      text: '',
      empty: true
    },
    symbolName: '',
    contextState: {
      focus: 'not-mounted',
      interactionTarget: 'unknown',
      capturedAt: new Date().toISOString(),
      documentRevision: documentRevisionForText(''),
      cursorOrigin: 'default',
      selectionOrigin: 'none',
      degradedReason: 'default_context'
    }
  };
}

function editorContextFromState(
  state: EditorState,
  focused = false,
  originOverride?: AiTeacherCursorOrigin
): SysmlEditorContext {
  const selection = state.selection.main;
  const from = editorPosition(state, selection.from);
  const to = editorPosition(state, selection.to);
  const content = state.doc.toString();
  return {
    cursor: editorPosition(state, selection.head),
    selection: {
      from,
      to,
      text: selection.empty ? '' : state.doc.sliceString(selection.from, selection.to),
      empty: selection.empty
    },
    symbolName: originOverride === 'default' ? '' : symbolAt(content, selection.head),
    contextState: {
      focus: focused ? 'focused' : 'blurred',
      interactionTarget: focused ? 'code' : 'unknown',
      capturedAt: new Date().toISOString(),
      documentRevision: documentRevisionForText(content),
      cursorOrigin: originOverride || (focused ? 'current' : 'last-known'),
      selectionOrigin: selection.empty ? 'none' : focused ? 'current' : 'last-known',
      degradedReason: originOverride === 'default' ? 'default_context' : focused ? '' : 'editor_blurred'
    }
  };
}

function editorPosition(state: EditorState, offset: number): SysmlEditorPosition {
  const safeOffset = Math.max(0, Math.min(Number(offset || 0), state.doc.length));
  const line = state.doc.lineAt(safeOffset);
  return {
    offset: safeOffset,
    line: line.number,
    column: safeOffset - line.from + 1
  };
}

function sysmlCompletionSource(context: CompletionContext) {
  const content = context.state.doc.toString();
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = context.state.doc.sliceString(line.from, context.pos);
  const memberMatch = beforeCursor.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
  if (memberMatch) {
    const prefix = memberMatch[2] || '';
    const options = sysmlCompletionOptions({ content, cursor: context.pos, explicit: context.explicit });
    return options.length ? { from: context.pos - prefix.length, options } : null;
  }
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_:]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const options = sysmlCompletionOptions({ content, cursor: context.pos, explicit: context.explicit });
  return options.length ? { from: word.from, options } : null;
}

function runTabCompletion(view: EditorView): boolean {
  const activeCompletionState = completionStatus(view.state);
  if (activeCompletionState === 'active') return acceptCompletion(view) || true;
  if (activeCompletionState === 'pending') return true;
  const selection = view.state.selection.main;
  if (!selection.empty) return indentMore(view);
  const cursor = selection.head;
  const content = view.state.doc.toString();
  const currentLine = view.state.doc.lineAt(cursor);
  const beforeCursor = view.state.doc.sliceString(currentLine.from, cursor);
  const nextChar = view.state.doc.sliceString(cursor, cursor + 1);
  const memberMatch = beforeCursor.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
  if (memberMatch && !/[\w:]/.test(nextChar)) {
    const prefix = memberMatch[2] || '';
    const member = sysmlMemberCompletionOptions(content, memberMatch[1], prefix)[0];
    if (member && member.name !== prefix) {
      view.dispatch({
        changes: { from: cursor - prefix.length, to: cursor, insert: member.name },
        selection: { anchor: cursor - prefix.length + member.name.length },
        userEvent: 'input.complete'
      });
      return true;
    }
  }
  const match = beforeCursor.match(/([A-Za-z_][\w:]*(?:\s+[A-Za-z_][\w:]*)?\s*)$/);
  if (match && !/[\w:]/.test(nextChar)) {
    const query = match[1].trimEnd();
    const completion = bestSysmlCompletion(query, sysmlCompletionCandidates({ content, cursor }));
    if (completion && completion !== query) {
      view.dispatch({
        changes: { from: cursor - match[1].length, to: cursor, insert: completion },
        selection: { anchor: cursor - match[1].length + completion.length },
        userEvent: 'input.complete'
      });
      return true;
    }
  }
  return indentMore(view);
}

function symbolAt(content: string, cursor: number): string {
  const left = content.slice(0, cursor).match(/[A-Za-z_][A-Za-z0-9_:]*$/)?.[0] || '';
  const right = content.slice(cursor).match(/^[A-Za-z0-9_:]+/)?.[0] || '';
  const symbol = `${left}${right}`;
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(symbol) ? symbol : '';
}

function wordRangeAt(content: string, cursor: number): { from: number; to: number; text: string } | null {
  const left = content.slice(0, cursor).match(/[A-Za-z_][A-Za-z0-9_:]*$/)?.[0] || '';
  const right = content.slice(cursor).match(/^[A-Za-z0-9_:]+/)?.[0] || '';
  const text = `${left}${right}`;
  if (!/^[A-Za-z_][A-Za-z0-9_:]*$/.test(text)) return null;
  return { from: cursor - left.length, to: cursor + right.length, text };
}

function editorSelectedText(view: EditorView | null): string {
  if (!view) return '';
  const selection = view.state.selection.main;
  if (selection.empty) return '';
  return view.state.doc.sliceString(selection.from, selection.to);
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const selection = window.getSelection();
  const previousRange = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const buffer = document.createElement('textarea');
  buffer.value = text;
  buffer.setAttribute('readonly', 'true');
  buffer.style.position = 'fixed';
  buffer.style.left = '-9999px';
  document.body.appendChild(buffer);
  buffer.select();
  document.execCommand('copy');
  document.body.removeChild(buffer);
  if (selection && previousRange) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
}

async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText) return navigator.clipboard.readText();
  return '';
}
