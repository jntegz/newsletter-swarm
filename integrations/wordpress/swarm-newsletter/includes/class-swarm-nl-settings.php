<?php
/**
 * Settings → Swarm.
 *
 * @package SwarmNewsletter
 */

defined( 'ABSPATH' ) || exit;

/**
 * The connection, the publication, the forms and the MCP switch.
 */
class Swarm_NL_Settings {

	const PAGE = 'swarm-newsletter';

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
	}

	/**
	 * The menu item.
	 */
	public static function menu() {
		add_options_page(
			__( 'Swarm', 'swarm-newsletter' ),
			__( 'Swarm', 'swarm-newsletter' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'page' )
		);
	}

	/**
	 * The setting.
	 */
	public static function register() {
		register_setting(
			self::PAGE,
			Swarm_NL_Client::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => array(),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * Cleans what the form sent. An empty key field keeps the saved key: the page never shows it.
	 *
	 * @param mixed $input The posted values.
	 * @return array
	 */
	public static function sanitize( $input ) {
		$input   = is_array( $input ) ? $input : array();
		$current = Swarm_NL_Client::settings();

		$url = esc_url_raw( trim( (string) ( $input['url'] ?? '' ) ), array( 'https', 'http' ) );
		if ( '' !== $url && 'http' === wp_parse_url( $url, PHP_URL_SCHEME ) && ! self::is_local( $url ) ) {
			// WordPress runs this twice on the very first save; say it once.
			if ( ! get_settings_errors( Swarm_NL_Client::OPTION ) ) {
				add_settings_error( Swarm_NL_Client::OPTION, 'swarm_nl_https', __( 'Use an https:// address, so your API key is not sent in the clear.', 'swarm-newsletter' ) );
			}
			$url = $current['url'];
		}

		$key = trim( sanitize_text_field( (string) ( $input['key'] ?? '' ) ) );
		if ( ! empty( $input['forget_key'] ) ) {
			$key = '';
		} elseif ( '' === $key ) {
			$key = $current['key'];
		}

		// The picker is only on the page when Swarm answered. Saving without it keeps the choice, so a
		// moment of downtime can't take the forms off the site.
		$channel = isset( $input['channel'] ) ? sanitize_text_field( (string) $input['channel'] ) : $current['channel'];
		if ( '' !== $channel && ! preg_match( '/^ch_[0-9a-f]{32}$/', $channel ) ) {
			$channel = '';
		}

		$agent_key = trim( sanitize_text_field( (string) ( $input['agent_key'] ?? '' ) ) );
		if ( ! empty( $input['forget_agent_key'] ) ) {
			$agent_key = '';
		} elseif ( '' === $agent_key ) {
			$agent_key = $current['agent_key'];
		}

		return array(
			'url'       => untrailingslashit( $url ),
			'key'       => $key,
			'channel'   => $channel,
			'mcp'       => ! empty( $input['mcp'] ),
			'agent_key' => $agent_key,
		);
	}

	/**
	 * Whether an address is on this machine, where plain http is fine.
	 *
	 * @param string $url The address.
	 * @return bool
	 */
	private static function is_local( $url ) {
		return in_array( wp_parse_url( $url, PHP_URL_HOST ), array( 'localhost', '127.0.0.1' ), true );
	}

	/**
	 * The page.
	 */
	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings  = Swarm_NL_Client::settings();
		$option    = Swarm_NL_Client::OPTION;
		$connected = Swarm_NL_Client::is_connected();
		$channels  = $connected ? Swarm_NL_Client::channels() : array();
		$from_file = defined( 'SWARM_NL_API_KEY' );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Swarm', 'swarm-newsletter' ); ?></h1>
			<?php if ( is_wp_error( $channels ) ) : ?>
				<div class="notice notice-error"><p><?php echo esc_html( $channels->get_error_message() ); ?></p></div>
			<?php endif; ?>
			<form method="post" action="options.php">
				<?php settings_fields( self::PAGE ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="swarm-nl-url"><?php esc_html_e( 'Swarm address', 'swarm-newsletter' ); ?></label></th>
						<td>
							<input id="swarm-nl-url" class="regular-text code" type="url" name="<?php echo esc_attr( $option ); ?>[url]" value="<?php echo esc_attr( $settings['url'] ); ?>" placeholder="https://app.example.com">
							<p class="description"><?php esc_html_e( 'The address you sign in to Swarm at.', 'swarm-newsletter' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="swarm-nl-key"><?php esc_html_e( 'API key', 'swarm-newsletter' ); ?></label></th>
						<td>
							<?php if ( $from_file ) : ?>
								<p><?php esc_html_e( 'Set by SWARM_NL_API_KEY in wp-config.php.', 'swarm-newsletter' ); ?></p>
							<?php else : ?>
								<input id="swarm-nl-key" class="regular-text code" type="password" autocomplete="off" name="<?php echo esc_attr( $option ); ?>[key]" value="" placeholder="<?php echo esc_attr( '' === $settings['key'] ? 'sk_live_…' : __( 'Saved. Leave empty to keep it.', 'swarm-newsletter' ) ); ?>">
								<?php if ( '' !== $settings['key'] ) : ?>
									<p><label><input type="checkbox" name="<?php echo esc_attr( $option ); ?>[forget_key]" value="1"> <?php esc_html_e( 'Remove the saved key', 'swarm-newsletter' ); ?></label></p>
								<?php endif; ?>
								<p class="description"><?php esc_html_e( 'Create one in Swarm under Settings → Developers → API keys, with channels:read and forms:read. Anyone who can read this site’s database can read a saved key, so to keep it out of there, define SWARM_NL_API_KEY in wp-config.php.', 'swarm-newsletter' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<?php if ( is_array( $channels ) && $channels ) : ?>
						<tr>
							<th scope="row"><label for="swarm-nl-channel"><?php esc_html_e( 'Publication', 'swarm-newsletter' ); ?></label></th>
							<td>
								<select id="swarm-nl-channel" name="<?php echo esc_attr( $option ); ?>[channel]">
									<option value=""><?php esc_html_e( 'Choose…', 'swarm-newsletter' ); ?></option>
									<?php foreach ( $channels as $channel ) : ?>
										<option value="<?php echo esc_attr( $channel['id'] ); ?>" <?php selected( $settings['channel'], $channel['id'] ); ?>><?php echo esc_html( $channel['name'] ); ?></option>
									<?php endforeach; ?>
								</select>
							</td>
						</tr>
					<?php endif; ?>
					<tr>
						<th scope="row"><?php esc_html_e( 'Agent access', 'swarm-newsletter' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( $option ); ?>[mcp]" value="1" <?php checked( $settings['mcp'] ); ?>> <?php esc_html_e( 'Let AI agents reach Swarm through this site', 'swarm-newsletter' ); ?></label>
							<p class="description"><?php esc_html_e( 'Agents sign in with a WordPress application password of an administrator, then act with the agent key below. Swarm records which WordPress user made each call. In Swarm, sends and other destructive calls wait for a person to approve them unless you changed that.', 'swarm-newsletter' ); ?></p>
							<?php if ( defined( 'SWARM_NL_AGENT_KEY' ) ) : ?>
								<p><?php esc_html_e( 'Agent key set by SWARM_NL_AGENT_KEY in wp-config.php.', 'swarm-newsletter' ); ?></p>
							<?php else : ?>
								<p><label for="swarm-nl-agent-key"><?php esc_html_e( 'Agent key', 'swarm-newsletter' ); ?></label><br>
								<input id="swarm-nl-agent-key" class="regular-text code" type="password" autocomplete="off" name="<?php echo esc_attr( $option ); ?>[agent_key]" value="" placeholder="<?php echo esc_attr( '' === $settings['agent_key'] ? 'sk_live_…' : __( 'Saved. Leave empty to keep it.', 'swarm-newsletter' ) ); ?>"></p>
								<?php if ( '' !== $settings['agent_key'] ) : ?>
									<p><label><input type="checkbox" name="<?php echo esc_attr( $option ); ?>[forget_agent_key]" value="1"> <?php esc_html_e( 'Remove the saved agent key', 'swarm-newsletter' ); ?></label></p>
								<?php endif; ?>
								<p class="description"><?php esc_html_e( 'Create a separate key in Swarm for "An AI agent" (MCP server only), with only the scopes agents need. It can’t be used to call Swarm’s API directly, so the site key above stays read-only.', 'swarm-newsletter' ); ?></p>
							<?php endif; ?>
							<?php if ( $settings['mcp'] ) : ?>
								<p><code><?php echo esc_html( rest_url( 'swarm-newsletter/v1/mcp' ) ); ?></code></p>
							<?php endif; ?>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
			<?php self::forms_table( $settings ); ?>
		</div>
		<?php
	}

	/**
	 * The published forms, with the shortcode to copy.
	 *
	 * @param array $settings The settings.
	 */
	private static function forms_table( $settings ) {
		if ( ! Swarm_NL_Client::is_connected() || '' === $settings['channel'] ) {
			return;
		}
		$forms = Swarm_NL_Client::published_forms();
		echo '<h2>' . esc_html__( 'Your forms', 'swarm-newsletter' ) . '</h2>';
		if ( is_wp_error( $forms ) ) {
			echo '<div class="notice notice-error inline"><p>' . esc_html( $forms->get_error_message() ) . '</p></div>';
			return;
		}
		if ( ! $forms ) {
			echo '<p>' . esc_html__( 'No published forms yet. Publish one in Swarm and it shows up here.', 'swarm-newsletter' ) . '</p>';
			return;
		}
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Form', 'swarm-newsletter' ) . '</th><th>' . esc_html__( 'Shortcode', 'swarm-newsletter' ) . '</th></tr></thead><tbody>';
		foreach ( $forms as $form ) {
			echo '<tr><td>' . esc_html( $form['name'] ) . '</td><td><code>[swarm_form id="' . esc_html( $form['id'] ) . '"]</code></td></tr>';
		}
		echo '</tbody></table>';
	}
}
