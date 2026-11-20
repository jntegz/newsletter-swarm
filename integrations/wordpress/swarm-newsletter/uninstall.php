<?php
/**
 * Removes what the plugin stored, including the saved API key.
 *
 * @package SwarmNewsletter
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

delete_option( 'swarm_nl_settings' );
// phpcs:ignore WordPress.DB.DirectDatabaseQuery
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( 'swarm_nl_' ) . '%',
		$wpdb->esc_like( '_transient_swarm_nl_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_swarm_nl_' ) . '%'
	)
);
