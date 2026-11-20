<?php
/**
 * An MCP endpoint on this site that forwards to the Swarm MCP server (docs/wordpress.md).
 *
 * Off until an administrator turns it on. A caller signs in to WordPress as an administrator
 * (normally with an application password) and the request goes on with the site's agent key (an
 * MCP-only Swarm key, separate from the read-only site key) and the WordPress user it came from.
 * Swarm still applies the key's scopes, its approval rules and its agent log.
 *
 * @package SwarmNewsletter
 */

defined( 'ABSPATH' ) || exit;

/**
 * POST /wp-json/swarm-newsletter/v1/mcp.
 */
class Swarm_NL_Mcp {

	/** Swarm's own limit on an MCP message. */
	const MAX_BODY = 1048576;

	/** Request headers MCP needs, passed on as they came. */
	const FORWARD_REQUEST = array( 'accept', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name' );

	/** Response headers a client acts on. WWW-Authenticate stays out: it points at Swarm's sign-in, not this site's. */
	const FORWARD_RESPONSE = array( 'content-type', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy' );

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register' ) );
	}

	/**
	 * The route exists only while the switch is on.
	 */
	public static function register() {
		if ( ! Swarm_NL_Client::settings()['mcp'] ) {
			return;
		}
		register_rest_route(
			'swarm-newsletter/v1',
			'/mcp',
			array(
				'methods'             => 'POST',
				'permission_callback' => static function () {
					return current_user_can( 'manage_options' );
				},
				'callback'            => array( __CLASS__, 'forward' ),
			)
		);
	}

	/**
	 * Sends the request on and answers with Swarm's bytes, so the JSON comes back exactly as it was
	 * sent (decoding and re-encoding in PHP would turn `{}` into `[]`).
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function forward( WP_REST_Request $request ) {
		if ( ! Swarm_NL_Client::is_connected() ) {
			return new WP_Error( 'swarm_nl_not_connected', __( 'Connect the plugin to Swarm first.', 'swarm-newsletter' ), array( 'status' => 503 ) );
		}
		$agent_key = Swarm_NL_Client::agent_key();
		if ( '' === $agent_key ) {
			return new WP_Error( 'swarm_nl_no_agent_key', __( 'Add an agent key (MCP server only) under Settings → Swarm Newsletter first.', 'swarm-newsletter' ), array( 'status' => 503 ) );
		}
		$body = $request->get_body();
		if ( strlen( $body ) > self::MAX_BODY ) {
			return new WP_Error( 'swarm_nl_too_large', __( 'The message is too large.', 'swarm-newsletter' ), array( 'status' => 413 ) );
		}
		$user    = wp_get_current_user();
		$headers = array(
			'Authorization'      => 'Bearer ' . $agent_key,
			// Which WordPress user made the call, so Swarm's agent log tells administrators apart.
			// Swarm records it as this site's claim, beside the key it verified.
			'X-Swarm-Acting-For' => substr( sprintf( 'WordPress %s user %d (%s)', (string) wp_parse_url( home_url(), PHP_URL_HOST ), (int) $user->ID, sanitize_user( (string) $user->user_login, true ) ), 0, 100 ),
		);
		foreach ( self::FORWARD_REQUEST as $name ) {
			$value = $request->get_header( $name );
			if ( null !== $value ) {
				$headers[ $name ] = $value;
			}
		}
		$response = wp_remote_post(
			Swarm_NL_Client::base_url() . '/mcp',
			array(
				'timeout'     => 60,
				'redirection' => 0,
				'headers'     => $headers,
				'body'        => $body,
			)
		);
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'swarm_nl_unreachable', __( 'Swarm could not be reached.', 'swarm-newsletter' ), array( 'status' => 502 ) );
		}

		$out = new WP_REST_Response( null, (int) wp_remote_retrieve_response_code( $response ) );
		foreach ( self::FORWARD_RESPONSE as $name ) {
			$value = wp_remote_retrieve_header( $response, $name );
			if ( '' !== $value && ! is_array( $value ) ) {
				$out->header( $name, $value );
			}
		}
		$raw = wp_remote_retrieve_body( $response );
		add_filter(
			'rest_pre_serve_request',
			static function ( $served ) use ( $raw ) {
				if ( ! $served ) {
					// Swarm's JSON, passed through unchanged.
					echo $raw; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
				}
				return true;
			}
		);
		return $out;
	}
}
