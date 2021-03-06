// @ts-check
/// <reference path="../typings/atom-ide.d.ts"/>
'use babel';

const { CompositeDisposable, Disposable, Range, Point, TextEditor } = require('atom');
const ProviderRegistry = require('./provider-registry');
const DataTipView = require('./datatip-view');

module.exports = class DatatipManager {

  constructor() {
    /**
     * [subscriptions description]
     * @type {CompositeDisposable}
     */
    this.subscriptions = null;
    /**
     * [providerRegistry description]
     * @type {ProviderRegistry}
     */
    this.providerRegistry = null;
    /**
     * [watchedEditors description]
     * @type {Array<TextEditor>}
     */
    this.watchedEditors = null;
    /**
     * [editor description]
     * @type {TextEditor}
     */
    this.editor = null;
    /**
     * [editorView description]
     * @type {object}
     */
    this.editorView = null;
    /**
     * [editorSubscriptions description]
     * @type {CompositeDisposable}
     */
    this.editorSubscriptions = null;
    /**
     * [dataTipMarkerDisposables description]
     * @type {CompositeDisposable}
     */
    this.dataTipMarkerDisposables = null;
    /**
     * [showDataTipOnCursorMove description]
     * @type {Boolean}
     */
    this.showDataTipOnCursorMove = false;
  }

  /**
   * [initialize description]
   */
  initialize() {
    this.subscriptions = new CompositeDisposable();
    this.providerRegistry = new ProviderRegistry();
    this.watchedEditors = new WeakSet();

    this.subscriptions.add(
      atom.workspace.observeTextEditors(editor => {
        const disposable = this.watchEditor(editor);
        editor.onDidDestroy(() => disposable.dispose());
      })
    );

    this.subscriptions.add(
      atom.commands.add('atom-text-editor', {
        'datatip:toggle': (evt) => {
          const editor = evt.currentTarget.getModel();
          if (atom.workspace.isTextEditor(editor)) {
            const position = evt.currentTarget.getModel().getCursorBufferPosition();
            this.showDataTip(editor, position, undefined);
          }
        }
      }),
      atom.config.observe('atom-ide-datatip.showDataTipOnCursorMove', toggleSwitch => {
        this.showDataTipOnCursorMove = toggleSwitch;
        // forces update of internal editor tracking
        const editor = this.editor;
        this.editor = null;
        this.updateCurrentEditor(editor);
      })
    );
  }

  /**
   * [dispose description]
   */
  dispose() {
    if (this.dataTipMarkerDisposables) {
        this.dataTipMarkerDisposables.dispose();
    }
    this.dataTipMarkerDisposables = null;

    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;

    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
  }

  /**
   * [addProvider description]
   * @param {AtomIDE.DatatipProvider} provider [description]
   * @returns {Disposable}
   */
  addProvider (provider) {
    return this.providerRegistry.addProvider(provider);
  }

  /**
   * [watchEditor description]
   * @param  {TextEditor} editor [description]
   * @return {Disposable | null}        [description]
   */
  watchEditor (editor) {
    if (this.watchedEditors.has(editor)) { return; }
    let editorView = atom.views.getView(editor);
    if (editorView.hasFocus()) {
      this.updateCurrentEditor(editor);
    }
    let focusListener = (element) => this.updateCurrentEditor(editor);
    editorView.addEventListener('focus', focusListener);
    let blurListener = (element) => this.hideDataTip();
    editorView.addEventListener('blur', blurListener);

    let disposable = new Disposable(() => {
      editorView.removeEventListener('focus', focusListener);
      editorView.removeEventListener('blur', blurListener);
      if (this.editor === editor) {
        this.updateCurrentEditor(null);
      }
    });

    this.watchedEditors.add(editor);
    this.subscriptions.add(disposable);

    return new Disposable(() => {
      disposable.dispose();
      if (this.subscriptions != null) {
        this.subscriptions.remove(disposable);
      }
      this.watchedEditors.delete(editor);
    });
  }

  /**
   * [updateCurrentEditor description]
   * @param  {TextEditor} editor [description]
   */
  updateCurrentEditor (editor) {
    if (editor === this.editor) { return; }
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;

    // Stop tracking editor + buffer; close any left-overs
    this.hideDataTip();
    this.editor = null;
    this.editorView = null;

    if (!atom.workspace.isTextEditor(editor)) { return; }

    this.editor = editor;
    this.editorView = atom.views.getView(this.editor);

    this.editorSubscriptions = new CompositeDisposable();

    this.editorSubscriptions.add(this.editor.onDidChangeCursorPosition((evt) => {
      if (evt.textChanged) return;
      const editor = evt.cursor.editor;
      const position = evt.cursor.getBufferPosition();
      if ((this.showDataTipOnCursorMove) &&
          (this.editor.getLastCursor().getBufferPosition().isEqual(evt.cursor.getBufferPosition()))) {
        this.showDataTip(editor, position, evt);
      }
      else {
        this.hideDataTip();
      }
     }));
  }

  /**
   * [showDataTip description]
   * @param  {TextEditor} editor   [description]
   * @param  {Point} position [description]
   */
  showDataTip (editor, position, evt) {
    const provider = this.providerRegistry.getProviderForEditor(editor);
    if (provider) {
      provider.datatip(editor, position, evt)
        .then((result) => {
          // clear last data tip
          this.hideDataTip();

          if (result && result.component){
            const dataTipView = new DataTipView({ component: result.component });
            this.dataTipMarkerDisposables = this.mountDataTipWithMarker(editor, result.range, position, dataTipView);
          }
          else if (result && result.markedStrings.length > 0) {
            let snippet, markedString, grammar;
            result.markedStrings.forEach(m => {
              switch(m.type) {
                case "snippet":
                  snippet = m.value;
                  grammar = m.grammar;
                  break;
                case "markdown":
                  markedString = m.value;
                  break;
              }
            });

            const dataTipView = new DataTipView({ snippet: snippet, grammar: grammar, markedString: markedString });
            this.dataTipMarkerDisposables = this.mountDataTipWithMarker(editor, result.range, position, dataTipView);
          }
        });
    }
  }

  /**
   * [mountDataTipWithMarker description]
   * @param  {TextEditor} editor   [description]
   * @param  {Range} range    [description]
   * @param  {Point} position [description]
   * @param  {DataTipView} view  [description]
   * @return {CompositeDisposable}          [description]
   */
  mountDataTipWithMarker(editor, range, position, view) {
    let disposables = new CompositeDisposable();

    // Highlight the text indicated by the datatip's range.
    const highlightMarker = editor.markBufferRange(range, {
      invalidate: 'never',
    });

    editor.decorateMarker(highlightMarker, {
      type: 'highlight',
      class: 'datatip-highlight-region',
    });

    // The actual datatip should appear at the trigger position.
    const overlayMarker = editor.markBufferRange(new Range(position, position), {
      invalidate: 'never',
    });

    const marker = editor.decorateMarker(overlayMarker, {
      type: 'overlay',
      class: 'datatip-overlay',
      position: 'tail',
      item: view.element,
    });
    view.element.style.display = 'block';

    disposables.add(
      new Disposable(() => highlightMarker.destroy()),
      new Disposable(() => overlayMarker.destroy()),
      new Disposable(() => view.destroy()),
      new Disposable(() => marker.destroy())
    );

    return disposables;
  }

  /**
   * [hideDataTip description]
   */
  hideDataTip () {
    if (this.dataTipMarkerDisposables) {
      this.dataTipMarkerDisposables.dispose();
    }
    this.dataTipMarkerDisposables = null;
  }
}
