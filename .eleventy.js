module.exports = function(eleventyConfig) {
  const markdownIt = require("markdown-it");
  const markdownItAnchor = require("markdown-it-anchor");
  const markdownItToc = require("markdown-it-toc-done-right");
  const hljs = require("highlight.js");

  const md = markdownIt({ 
    html: true,
    highlight: function (str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="highlight"><code class="hljs">' +
                 hljs.highlight(str, { language: lang }).value +
                 '</code></pre>';
        } catch (__) {}
      }
      return '<pre class="highlight"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    }
  })
    .use(markdownItAnchor, {
      permalink: false,
      slugify: (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
    })
    .use(markdownItToc, { listType: "ul" });

  eleventyConfig.setLibrary("md", md);

  eleventyConfig.addPassthroughCopy("assets/favicon-32x32.png");
  eleventyConfig.addPassthroughCopy("assets/favicon-16x16.png");
  eleventyConfig.addPassthroughCopy("assets/apple-touch-icon.png");
  eleventyConfig.addPassthroughCopy("assets/logo.png");
  eleventyConfig.addPassthroughCopy("assets/images");
  eleventyConfig.addPassthroughCopy("assets/js");
  eleventyConfig.addPassthroughCopy("favicon.ico");

  // Self-contained apps under /apps/. Each app owns its own CSS and JS and
  // is not part of the site's Sass build, so both directories are copied
  // verbatim. See apps/options/DESIGN.md.
  eleventyConfig.addPassthroughCopy("apps/options/css");
  eleventyConfig.addPassthroughCopy("apps/options/js");

  // Third-party chart bundles, installed from npm and vendored into the
  // build output rather than loaded from a CDN. Self-hosting keeps the
  // version pinned in package.json, removes a runtime dependency on
  // someone else's uptime, and avoids a bundler. Update the version by
  // running npm install; these paths do not change.
  eleventyConfig.addPassthroughCopy({
    "node_modules/chart.js/dist/chart.umd.js":
      "apps/options/vendor/chart.umd.js",
    "node_modules/chartjs-plugin-annotation/dist/chartjs-plugin-annotation.min.js":
      "apps/options/vendor/chartjs-plugin-annotation.min.js",
  });

  eleventyConfig.addCollection("posts", function(collectionApi) {
    return collectionApi.getFilteredByGlob("_posts/*.md").reverse();
  });

  // Self-contained apps under /apps/. Discovered by glob rather than listed
  // anywhere, so dropping in apps/<name>/index.html with `title` and
  // `summary` front matter makes it appear on /apps/ with no config change.
  // The glob requires a subdirectory, so apps/index.njk never lists itself.
  eleventyConfig.addCollection("apps", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("apps/*/index.html")
      .sort((a, b) => (a.data.title || "").localeCompare(b.data.title || ""));
  });

  eleventyConfig.addCollection("tagList", function(collectionApi) {
    const tagSet = new Set();
    collectionApi.getAll().forEach(item => {
      if (item.data.tags) {
        item.data.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return [...tagSet].sort();
  });

  eleventyConfig.addFilter("dateDisplay", function(date) {
    return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  });

  eleventyConfig.addFilter("date", function(date, format) {
    const d = new Date(date);
    if (format === 'YYYY') return d.getFullYear();
    if (format === 'YYYY-MM-DD') return d.toISOString().split('T')[0];
    return d.toLocaleDateString();
  });

  eleventyConfig.addFilter("excerpt", function(content) {
    const separator = "<!--more-->";
    if (content.includes(separator)) {
      return content.split(separator)[0].replace(/<[^>]*>/g, '');
    }
    return content.replace(/<[^>]*>/g, '').split(' ').slice(0, 30).join(' ');
  });

  eleventyConfig.addFilter("groupby", function(collection, key) {
    const groups = {};
    collection.forEach(item => {
      const tags = item.data[key] || [];
      tags.forEach(tag => {
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push(item);
      });
    });
    return Object.entries(groups);
  });

  eleventyConfig.addFilter("relative_url", function(url) {
    return url.startsWith('/') ? url : '/' + url;
  });

  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "_includes",
      layouts: "_layouts"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};
