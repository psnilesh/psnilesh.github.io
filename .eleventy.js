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

  eleventyConfig.addCollection("posts", function(collectionApi) {
    return collectionApi.getFilteredByGlob("_posts/*.md").reverse();
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
