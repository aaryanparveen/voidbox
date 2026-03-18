import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

const boldTypoTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#0F0F0F',
      color: '#FAFAFA',
      fontSize: '14px',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-content': {
      caretColor: '#FF3D00',
      lineHeight: '1.6',
      padding: '12px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#FF3D00',
      borderLeftWidth: '2px',
    },
    '.cm-activeLine': {
      backgroundColor: '#FFFFFF06',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: '#FF3D0018 !important',
    },
    '.cm-gutters': {
      backgroundColor: '#0A0A0A',
      color: '#737373',
      border: 'none',
      borderRight: '1px solid #262626',
      minWidth: '48px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: '#FAFAFA',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 12px 0 16px',
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: '12px',
      letterSpacing: '0.05em',
    },
    '.cm-foldGutter': {
      padding: '0 4px',
    },
    '.cm-tooltip': {
      backgroundColor: '#1A1A1A',
      border: '1px solid #262626',
      borderRadius: '0',
      boxShadow: 'none',
      color: '#FAFAFA',
    },
    '.cm-tooltip-autocomplete': {
      '& > ul > li': {
        padding: '4px 12px',
      },
      '& > ul > li[aria-selected]': {
        backgroundColor: '#FF3D0015',
        color: '#FF3D00',
      },
    },
    '.cm-panels': {
      backgroundColor: '#0A0A0A',
      borderTop: '1px solid #262626',
    },
    '.cm-searchMatch': {
      backgroundColor: '#FF3D0025',
      outline: '1px solid #FF3D0050',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: '#FF3D0040',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#FF3D0012',
    },
    '.cm-matchingBracket': {
      backgroundColor: '#FF3D0020',
      outline: '1px solid #FF3D0040',
      color: '#FF3D00',
    },
    '.cm-scroller': {
      overflow: 'auto',
      scrollbarWidth: 'thin',
      scrollbarColor: '#FF3D00 #0A0A0A',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '10px',
      height: '10px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      backgroundColor: '#0A0A0A',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'linear-gradient(180deg, #FF3D00 0%, #FF6A3D 100%)',
      border: '2px solid #0A0A0A',
      borderRadius: '999px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      background: 'linear-gradient(180deg, #FF6A3D 0%, #FF3D00 100%)',
    },
    '.cm-scroller::-webkit-scrollbar-corner': {
      backgroundColor: '#0A0A0A',
    },
  },
  { dark: true }
);

const syntaxTheme = EditorView.theme({
  '.cm-keyword': { color: '#FF3D00' },
  '.cm-string': { color: '#4ADE80' },
  '.cm-number': { color: '#FACC15' },
  '.cm-comment': { color: '#737373', fontStyle: 'italic' },
  '.cm-function': { color: '#60A5FA' },
  '.cm-property': { color: '#FAFAFA' },
  '.cm-operator': { color: '#FF3D00' },
  '.cm-punctuation': { color: '#737373' },
  '.cm-typeName': { color: '#C084FC' },
  '.cm-tag': { color: '#FF3D00' },
  '.cm-attributeName': { color: '#FACC15' },
  '.cm-attributeValue': { color: '#4ADE80' },
  '.cm-heading': { color: '#60A5FA', fontWeight: '700' },
  '.cm-link': { color: '#4ADE80', textDecoration: 'underline' },
  '.cm-url': { color: '#4ADE80' },
  '.cm-strong': { color: '#FAFAFA', fontWeight: '700' },
  '.cm-emphasis': { color: '#FAFAFA', fontStyle: 'italic' },
  '.cm-quote': { color: '#737373', fontStyle: 'italic' },
  '.cm-monospace': { color: '#FACC15' },
}, { dark: true });

const languageCompartment = new Compartment();

function getLanguageExtension(filename: string) {
  const normalizedName = filename.trim().toLowerCase();
  const ext = normalizedName.split('.').pop() || '';

  if (normalizedName === 'readme' || normalizedName.startsWith('readme.')) {
    return markdown();
  }

  switch (ext) {
    case 'md': case 'markdown': case 'mdx':
      return markdown();
    case 'js': case 'mjs': case 'cjs':
      return javascript();
    case 'ts': case 'mts': case 'cts':
      return javascript({ typescript: true });
    case 'jsx':
      return javascript({ jsx: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw':
      return python();
    case 'html': case 'htm': case 'svelte': case 'vue':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'json': case 'jsonc':
      return json();
    default:
      return javascript();
  }
}

export interface CodeEditor {
  view: EditorView;
  setContent: (content: string, filename?: string) => void;
  getContent: () => string;
  setLanguage: (filename: string) => void;
  resize: () => void;
  destroy: () => void;
  onSave: (callback: (content: string) => void) => void;
  onChange: (callback: (content: string) => void) => void;
}

export function createEditor(
  container: HTMLElement,
  initialContent: string = '',
  filename: string = 'untitled.js'
): CodeEditor {
  let saveCallback: ((content: string) => void) | null = null;
  let changeCallback: ((content: string) => void) | null = null;

  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      run: (view) => {
        if (saveCallback) {
          saveCallback(view.state.doc.toString());
        }
        return true;
      },
    },
  ]);

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      basicSetup,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      saveKeymap,
      languageCompartment.of(getLanguageExtension(filename)),
      boldTypoTheme,
      syntaxTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && changeCallback) {
          changeCallback(update.state.doc.toString());
        }
      }),
    ],
  });

  const view = new EditorView({
    state,
    parent: container,
  });

  return {
    view,
    setContent: (content: string, newFilename?: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
      if (newFilename) {
        view.dispatch({
          effects: languageCompartment.reconfigure(getLanguageExtension(newFilename)),
        });
      }
    },
    getContent: () => view.state.doc.toString(),
    setLanguage: (fname: string) => {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(fname)),
      });
    },
    resize: () => view.requestMeasure(),
    destroy: () => view.destroy(),
    onSave: (callback: (content: string) => void) => {
      saveCallback = callback;
    },
    onChange: (callback: (content: string) => void) => {
      changeCallback = callback;
    },
  };
}


