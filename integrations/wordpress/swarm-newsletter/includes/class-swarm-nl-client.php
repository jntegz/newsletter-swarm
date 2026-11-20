<?php
/**
 * Calls to the Swarm API with the site's stored key.
 *
 * @package SwarmNewsletter
 */

defined( 'ABSPATH' ) || exit;

/**
 * The stored settings and the /v2 requests the plugin makes.
 */
class Swarm_NL_Client {

	const OPTION = 'swarm_nl_settings';

	/**
	 * The saved settings, with defaults.
	 *
	 * @return array{url: string, key: string, channel: string, mcp: bool, agent_key: string}
	 */
	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		return array_merge(
			array(
				'url'       => '',
				'key'       => '',
				'channel'   => '',
				'mcp'       => false,
				'agent_key' => '',
			),
			is_array( $saved ) ? $saved : array()
		);
	}

	/**
	 * The API key. A SWARM_NL_API_KEY constant in wp-config.php wins, and keeps the key out of the
	 * database.
	 *
	 * @return string
	 */
	public static function api_key() {
		if ( defined( 'SWARM_NL_API_KEY' ) ) {
			return (string) SWARM_NL_API_KEY;
		}
		return self::settings()['key'];
	}

	/**
	 * The key the MCP bridge forwards with: an agent key (Swarm's "An AI agent" key, which works on
	 * Swarm's MCP server only), never the site key, so whoever reads it can't call the API
	 * directly with it. A SWARM_NL_AGENT_KEY constant in wp-config.php wins.
	 *
	 * @return string
	 */
	public static function agent_key() {
		if ( defined( 'SWARM_NL_AGENT_KEY' ) ) {
			return (string) SWARM_NL_AGENT_KEY;
		}
		return (string) self::settings()['agent_key'];
	}

	/**
	 * The Swarm address, without a trailing slash.
	 *
	 * @return string
	 */
	public static function base_url() {
		return untrailingslashit( self::settings()['url'] );
	}

	/**
	 * Whether there is an address and a key to call with.
	 *
	 * @return bool
	 */
	public static function is_connected() {
		return '' !== self::base_url() && '' !== self::api_key();
	}

	/**
	 * GET a /v2 path and return what is in `data`.
	 *
	 * @param string $path The path, starting with /v2/.
	 * @return mixed|WP_Error
	 */
	public static function get( $path ) {
		if ( ! self::is_connected() ) {
			return new WP_Error( 'swarm_nl_not_connected', __( 'Connect the plugin to Swarm first.', 'swarm-newsletter' ) );
		}
		$response = wp_remote_get(
			self::base_url() . $path,
			array(
				'timeout'     => 10,
				// A redirect could carry the key somewhere else.
				'redirection' => 0,
				'headers'     => array(
					'Authorization' => 'Bearer ' . self::api_key(),
					'Accept'        => 'application/json',
				),
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( $status < 200 || $status >= 300 || ! is_array( $body ) || ! array_key_exists( 'data', $body ) ) {
			$message = is_array( $body ) && isset( $body['error']['message'] )
				? (string) $body['error']['message']
				/* translators: %d: an HTTP status code. */
				: sprintf( __( 'Swarm answered with status %d.', 'swarm-newsletter' ), $status );
			return new WP_Error( 'swarm_nl_api', $message, array( 'status' => $status ) );
		}
		return $body['data'];
	}

	/**
	 * The publications this key can reach.
	 *
	 * @return array|WP_Error
	 */
	public static function channels() {
		return self::get( '/v2/channels' );
	}

	/**
	 * The published forms of the chosen publication. Smart Prompts are left out: the Swarm website
	 * shows those.
	 *
	 * @return array|WP_Error
	 */
	public static function published_forms() {
		$channel = self::settings()['channel'];
		if ( '' === $channel ) {
			return new WP_Error( 'swarm_nl_no_publication', __( 'Choose a publication first.', 'swarm-newsletter' ) );
		}
		$forms = self::get( '/v2/channels/' . rawurlencode( $channel ) . '/capture-forms?kind=form' );
		if ( is_wp_error( $forms ) ) {
			return $forms;
		}
		$published = array();
		foreach ( $forms as $form ) {
			if ( 'published' === ( $form['status'] ?? '' ) ) {
				$published[] = array(
					'id'   => (string) $form['id'],
					'name' => (string) $form['name'],
				);
			}
		}
		return $published;
	}
}
