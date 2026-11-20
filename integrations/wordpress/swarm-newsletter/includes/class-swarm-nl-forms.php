<?php
/**
 * The [swarm_form] shortcode and the form block.
 *
 * The form's HTML comes from Swarm (GET .../capture-forms/{id}/snippet), so custom fields, consent
 * and the spam trap stay Swarm's. The visitor's browser posts straight to Swarm: this site never
 * handles an address, and Swarm's own rate limits and bot check see the visitor.
 *
 * @package SwarmNewsletter
 */

defined( 'ABSPATH' ) || exit;

/**
 * Renders forms, from a short-lived copy so a page view doesn't wait on the API, and from the last
 * good copy when Swarm can't be reached.
 */
class Swarm_NL_Forms {

	const CACHE_SECONDS = 300;

	/**
	 * Hooks.
	 */
	public static function init() {
		add_shortcode( 'swarm_form', array( __CLASS__, 'shortcode' ) );
		add_action( 'init', array( __CLASS__, 'register_block' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest' ) );
	}

	/**
	 * The block, rendered on the server by the same code as the shortcode.
	 */
	public static function register_block() {
		wp_register_style( 'swarm-nl-form', false, array(), SWARM_NL_VERSION );
		// The spam trap: people never see it, and bots fill it in.
		wp_add_inline_style( 'swarm-nl-form', '.swarm-nl-form input[name="website"]{position:absolute;left:-10000px}' );
		register_block_type(
			SWARM_NL_DIR . 'blocks/form',
			array( 'render_callback' => array( __CLASS__, 'render_block' ) )
		);
	}

	/**
	 * The list of forms the block's picker shows, for people who can edit posts.
	 */
	public static function register_rest() {
		register_rest_route(
			'swarm-newsletter/v1',
			'/forms',
			array(
				'methods'             => 'GET',
				'permission_callback' => static function () {
					return current_user_can( 'edit_posts' );
				},
				'callback'            => static function () {
					$forms = Swarm_NL_Client::published_forms();
					return is_wp_error( $forms ) ? array() : $forms;
				},
			)
		);
	}

	/**
	 * The block's render callback.
	 *
	 * @param array $attributes Block attributes.
	 * @return string
	 */
	public static function render_block( $attributes ) {
		return self::render( (string) ( $attributes['formId'] ?? '' ), (string) ( $attributes['mode'] ?? 'plain' ) );
	}

	/**
	 * [swarm_form id="cf_…" mode="plain|script"].
	 *
	 * @param array|string $atts Shortcode attributes.
	 * @return string
	 */
	public static function shortcode( $atts ) {
		$atts = shortcode_atts(
			array(
				'id'   => '',
				'mode' => 'plain',
			),
			$atts,
			'swarm_form'
		);
		return self::render( (string) $atts['id'], (string) $atts['mode'] );
	}

	/**
	 * The form's HTML. Visitors see nothing when it can't be shown; people who can edit the page see
	 * why.
	 *
	 * @param string $form_id The form's id.
	 * @param string $mode    'plain' (an HTML form, no JavaScript) or 'script' (Swarm's embed, with
	 *                        the form's popup, slide-in or sticky placement).
	 * @return string
	 */
	public static function render( $form_id, $mode = 'plain' ) {
		if ( ! preg_match( '/^cf_[0-9a-f]{32}$/', $form_id ) ) {
			return self::problem( __( 'This form has no valid id. Choose it again.', 'swarm-newsletter' ) );
		}
		$snippet = self::snippet( $form_id );
		if ( is_wp_error( $snippet ) ) {
			return self::problem( $snippet->get_error_message() );
		}
		if ( 'script' === $mode ) {
			return self::script_tag( $snippet );
		}
		wp_enqueue_style( 'swarm-nl-form' );
		$html = wp_kses( (string) ( $snippet['noscript'] ?? '' ), self::allowed_html() );
		return '<div class="swarm-nl-form">' . $html . '</div>';
	}

	/**
	 * The snippet: the fresh copy, else from Swarm, else the last good copy.
	 *
	 * @param string $form_id The form's id.
	 * @return array|WP_Error
	 */
	private static function snippet( $form_id ) {
		$channel = Swarm_NL_Client::settings()['channel'];
		if ( '' === $channel ) {
			return new WP_Error( 'swarm_nl_no_publication', __( 'Choose a publication in Settings → Swarm.', 'swarm-newsletter' ) );
		}
		$key    = 'swarm_nl_' . md5( $channel . '|' . $form_id );
		$cached = get_transient( $key );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$fresh = Swarm_NL_Client::get(
			'/v2/channels/' . rawurlencode( $channel ) . '/capture-forms/' . rawurlencode( $form_id ) . '/snippet'
		);
		if ( is_wp_error( $fresh ) ) {
			$status = $fresh->get_error_data()['status'] ?? 0;
			$stale  = get_option( $key . '_last' );
			// A form Swarm says is gone stays gone. Anything else may pass, so keep showing the form.
			if ( 404 !== $status && is_array( $stale ) ) {
				set_transient( $key, $stale, MINUTE_IN_SECONDS );
				return $stale;
			}
			return $fresh;
		}
		set_transient( $key, $fresh, self::CACHE_SECONDS );
		update_option( $key . '_last', $fresh, false );
		return $fresh;
	}

	/**
	 * Swarm's embed script, pinned to the published version by its integrity hash.
	 *
	 * @param array $snippet The snippet.
	 * @return string
	 */
	private static function script_tag( $snippet ) {
		if ( empty( $snippet['scriptUrl'] ) || empty( $snippet['integrity'] ) ) {
			return '';
		}
		return wp_get_script_tag(
			array(
				'src'         => esc_url_raw( $snippet['scriptUrl'] ),
				'integrity'   => (string) $snippet['integrity'],
				'crossorigin' => 'anonymous',
				'async'       => true,
			)
		);
	}

	/**
	 * What a form may contain.
	 *
	 * @return array
	 */
	private static function allowed_html() {
		$field = array(
			'type'         => true,
			'name'         => true,
			'value'        => true,
			'required'     => true,
			'placeholder'  => true,
			'autocomplete' => true,
			'maxlength'    => true,
			'step'         => true,
			'tabindex'     => true,
			'aria-hidden'  => true,
		);
		return array(
			'form'     => array(
				'action' => true,
				'method' => true,
			),
			'label'    => array(),
			'fieldset' => array(),
			'legend'   => array(),
			'input'    => $field,
			'select'   => $field,
			'option'   => array( 'value' => true ),
			'button'   => array( 'type' => true ),
		);
	}

	/**
	 * A note for people who can fix it; nothing for visitors.
	 *
	 * @param string $message The problem.
	 * @return string
	 */
	private static function problem( $message ) {
		if ( ! current_user_can( 'edit_posts' ) ) {
			return '';
		}
		return '<p class="swarm-nl-problem"><strong>' . esc_html__( 'Swarm form:', 'swarm-newsletter' ) . '</strong> ' . esc_html( $message ) . '</p>';
	}
}
