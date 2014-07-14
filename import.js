var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

var getRecipeDetails, getImportedRecipes;

/**
 * Get a list of the ids of all already important recipes.
 */
getImportedRecipes = function () {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 9000
  }).then(function (results) {
    deferred.resolve(_.map(results.hits.hits, function (recipe) {
      return parseInt(recipe._id, 10);
    }));
  });
  return deferred.promise;
};

/**
 * Get the details for a specific recipe.
 */
getRecipeDetails = function (recipe_id) {
    request({
        url: 'https://api.guildwars2.com/v1/recipe_details.json',
        qs: {recipe_id: recipe_id},
        json: true
    }, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        client.index({
          index: 'gw2',
          type: 'recipe',
          id: recipe_id,
          body: body
        }).then(function () {
          console.log('SUCCESS '+ recipe_id);
        }).catch(function () {
          console.log('ERROR '+ recipe_id);
        });
      }
    });
};

request({
  url: 'https://api.guildwars2.com/v1/recipes.json',
  json: true
}, function (error, response, body) {
  if (!error && response.statusCode === 200) {
    getImportedRecipes().then(function (imported) {
      var recipes = _.difference(body.recipes, imported);
      if (!recipes.length) {
        console.info('All recipes already imported');
        process.exit();
      } else {
        console.info('Attempting to import '+ recipes.length +' missing recipes');
        _.forEach(recipes, getRecipeDetails);
      }
    });
  }
});
