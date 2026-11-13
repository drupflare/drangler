CREATE DATABASE IF NOT EXISTS site_a;
CREATE DATABASE IF NOT EXISTS empty_db;
GRANT ALL ON site_a.* TO 'drupal'@'%';
GRANT ALL ON empty_db.* TO 'drupal'@'%';
