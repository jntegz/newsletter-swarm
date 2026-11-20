<?php
/**
 * Test helpers for the WordPress story, loaded only by playwright.wordpress.config.ts.
 *
 * @package SwarmNewsletter
 */

// Playground serves plain http; WordPress offers application passwords only over https otherwise.
add_filter( 'wp_is_application_passwords_available', '__return_true' );
add_filter( 'wp_is_application_passwords_available_for_user', '__return_true' );

add_action(
	'rest_api_init',
	static function () {
		$route = static function ( $path, $callback ) {
			register_rest_route(
				'swarm-test/v1',
				$path,
				array(
					'methods'             => 'POST',
					'permission_callback' => '__return_true',
					'callback'            => $callback,
				)
			);
		};
		// What this run is really on, so asking for an old version can't quietly test a new one.
		$route(
			'/versions',
			static function () {
				return array(
					'php' => PHP_VERSION,
					'wp'  => get_bloginfo( 'version' ),
				);
			}
		);
		// Makes the fresh copy of every form expire, as five minutes passing would.
		$route(
			'/expire',
			static function () {
				global $wpdb;
				return $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient%swarm\_nl\_%'" );
			}
		);
		// Runs the plugin's uninstall without deleting its files: the plugin folder is mounted from the
		// repository, so deleting the plugin through WordPress would delete the source.
		$route(
			'/uninstall',
			static function () {
				if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
					define( 'WP_UNINSTALL_PLUGIN', 'swarm-newsletter/swarm-newsletter.php' );
				}
				include WP_PLUGIN_DIR . '/swarm-newsletter/uninstall.php';
				global $wpdb;
				return $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE '%swarm\_nl\_%'" );
			}
		);
	}
);
