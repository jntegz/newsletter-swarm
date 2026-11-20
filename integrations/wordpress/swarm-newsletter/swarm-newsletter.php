<?php
/**
 * Plugin Name:       Swarm Newsletter
 * Description:       Subscribe forms from your Swarm publication, as a shortcode and a block, and an optional MCP endpoint for AI agents.
 * Version:           0.1.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * Author:            Swarm
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       swarm-newsletter
 *
 * @package SwarmNewsletter
 */

defined( 'ABSPATH' ) || exit;

define( 'SWARM_NL_VERSION', '0.1.0' );
define( 'SWARM_NL_FILE', __FILE__ );
define( 'SWARM_NL_DIR', plugin_dir_path( __FILE__ ) );

require_once SWARM_NL_DIR . 'includes/class-swarm-nl-client.php';
require_once SWARM_NL_DIR . 'includes/class-swarm-nl-forms.php';
require_once SWARM_NL_DIR . 'includes/class-swarm-nl-settings.php';
require_once SWARM_NL_DIR . 'includes/class-swarm-nl-mcp.php';

Swarm_NL_Forms::init();
Swarm_NL_Settings::init();
Swarm_NL_Mcp::init();
