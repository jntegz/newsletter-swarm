// The form block in the editor: pick a published form, see it as visitors will. No build step, so
// it uses the editor's own globals.
/* global wp */
(function () {
  const { registerBlockType } = wp.blocks;
  const { createElement: el, useEffect, useState, Fragment } = wp.element;
  const { InspectorControls, useBlockProps } = wp.blockEditor;
  const { PanelBody, SelectControl, Placeholder, Spinner } = wp.components;
  const { __ } = wp.i18n;
  const ServerSideRender = wp.serverSideRender;

  registerBlockType('swarm-newsletter/form', {
    edit({ attributes, setAttributes }) {
      const [forms, setForms] = useState(null);
      const blockProps = useBlockProps();

      useEffect(() => {
        let live = true;
        wp.apiFetch({ path: '/swarm-newsletter/v1/forms' })
          .then((list) => live && setForms(list))
          .catch(() => live && setForms([]));
        return () => {
          live = false;
        };
      }, []);

      const options = [{ value: '', label: __('Choose a form…', 'swarm-newsletter') }].concat(
        (forms || []).map((form) => ({ value: form.id, label: form.name })),
      );
      const picker = el(SelectControl, {
        label: __('Form', 'swarm-newsletter'),
        value: attributes.formId,
        options,
        onChange: (formId) => setAttributes({ formId }),
      });

      return el(
        Fragment,
        null,
        el(
          InspectorControls,
          null,
          el(
            PanelBody,
            { title: __('Form', 'swarm-newsletter') },
            picker,
            el(SelectControl, {
              label: __('Show it as', 'swarm-newsletter'),
              value: attributes.mode,
              options: [
                {
                  value: 'plain',
                  label: __('A form on the page, without JavaScript', 'swarm-newsletter'),
                },
                {
                  value: 'script',
                  label: __('Swarm’s embed, with its popup or slide-in', 'swarm-newsletter'),
                },
              ],
              onChange: (mode) => setAttributes({ mode }),
            }),
          ),
        ),
        el(
          'div',
          blockProps,
          forms === null
            ? el(Spinner)
            : attributes.formId
              ? el(ServerSideRender, { block: 'swarm-newsletter/form', attributes })
              : el(
                  Placeholder,
                  {
                    label: __('Swarm form', 'swarm-newsletter'),
                    instructions: forms.length
                      ? __('Choose which form to show.', 'swarm-newsletter')
                      : __(
                          'No published forms found. Check Settings → Swarm, and publish a form in Swarm.',
                          'swarm-newsletter',
                        ),
                  },
                  forms.length ? picker : null,
                ),
        ),
      );
    },
    save: () => null,
  });
})();
