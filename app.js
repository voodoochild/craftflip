var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

var names = {};
var recipes = {};
var prices = {};
var ingredientRecipeIds = {};

var getNames, getPrices, getRecipes, getRecipeForItem, traverseRecipe, showPrices, renderRecipe, rounded;

String.prototype.repeat = function (count) {
  if (count < 1) { return ''; }
  var result = '', pattern = this.valueOf();
  while (count > 1) {
    if (count & 1) { result += pattern; }
    count >>= 1, pattern += pattern;
  }
  return result + pattern;
};

rounded = function (num) {
  var sign = num >= 0 ? 1 : -1;
  return (Math.round((num * Math.pow(10, 2)) + (sign  *0.001)) / Math.pow(10, 2)).toFixed(2);
};

getNames = function () {
  var deferred = q.defer();
  request({
      url: 'http://api.gw2tp.com/1/bulk/items-names.json',
      json: true
  }, function (error, response, body) {
    _.forEach(body.items, function (item) {
      names[item[0]] = item[1];
    });
    deferred.resolve();
  });
  return deferred.promise;
};

getPrices = function () {
  var deferred = q.defer();
  request({
      url: 'http://api.gw2tp.com/1/bulk/items.json',
      json: true
  }, function (error, response, body) {
    _.forEach(body.items, function (item) {
      item = _.zipObject(body.columns, item);
      prices[item.id] = { buy: item.buy, sell: item.sell };
    });
    deferred.resolve();
  });
  return deferred.promise;
};

getRecipes = function () {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 9000,
    body: {
      filter: {
        bool: {
          must: {
            range: {
              min_rating: {
                lte: '400'
              }
            }
          },
          must_not: {
            query: {
              match: {
                flags: 'LearnedFromItem'
              }
            }
          }
        }
      }
    }
  }).then(function (results) {
    _.forEach(results.hits.hits, function (recipe) {
      recipe._source.output_item_name = names[recipe._source.output_item_id] || '<no name>';
      if (recipe._source.output_item_name.match(/\+\d+ Agony Infusion/)) { return; }
      recipes[recipe._id] = recipe._source;
    });
    deferred.resolve();
  });
  return deferred.promise;
};

getRecipeForItem = function (item_id) {
  var deferred = q.defer();
  if (ingredientRecipeIds.hasOwnProperty(item_id)) {
    deferred.resolve(recipes[ingredientRecipeIds[item_id]]);
  } else {
    client.search({
      index: 'gw2',
      type: 'recipe',
      size: 1,
      body: {
        query: {
          match: {
            output_item_id: item_id
          }
        }
      }
    }).then(function (results) {
      if (results.hits.total) {
        deferred.resolve(recipes[results.hits.hits[0]._id]);
      } else {
        deferred.resolve(false);
      }
    });
  }
  return deferred.promise;
};

traverseRecipe = function (recipe) {
  var deferred = q.defer();

  if (!prices[recipe.output_item_id]) {
    prices[recipe.output_item_id] = { buy: 0, sell: 0 };
    recipe.unavailable = true;
  } else if (prices[recipe.output_item_id].hasOwnProperty('craft')) {
    deferred.resolve(recipe);
    return deferred;
  }

  if (recipe.ingredients.length) {
    var getRecipePromises = [];
    var traversePromises = [];
    var sum = 0;

    _.forEach(recipe.ingredients, function (ingredient) {
      var p1 = getRecipeForItem(ingredient.item_id);
      getRecipePromises.push(p1);
      p1.then(function (ingredientRecipe) {
        if (ingredientRecipe) {
          ingredientRecipeIds[ingredient.item_id] = ingredientRecipe.recipe_id;
          var p2 = traverseRecipe(ingredientRecipe);
          traversePromises.push(p2);
          p2.then(function () {
            if (prices[ingredient.item_id]) {
              if (prices[ingredient.item_id].hasOwnProperty('craft')) {
                sum += prices[ingredient.item_id].craft * ingredient.count;
              } else {
                sum += prices[ingredient.item_id].sell * ingredient.count;
              }
            }
          });
        } else {
          if (prices[ingredient.item_id]) {
            sum += prices[ingredient.item_id].sell * ingredient.count;
          }
        }
      });
    });

    q.all(getRecipePromises)
      .then(function () {
        q.all(traversePromises)
          .then(function () {
            if (prices[recipe.output_item_id]) {
              prices[recipe.output_item_id].craft = sum;
            }
            deferred.resolve(recipe);
          });
      });
  } else {
    deferred.resolve(recipe);
  }

  return deferred.promise;
};

showPrices = function (recipe) {
  var recipePrices = prices[recipe.output_item_id];
  if (!recipe.unavailable && recipePrices.buy && recipePrices.sell && recipePrices.craft) {
    var spreadBuy = recipePrices.buy - ((recipePrices.craft * recipe.output_item_count) * 1.15);
    if (spreadBuy > 100) {
      var line = '\n'+ '-'.repeat(60) +'\n';
      process.stdout.write('\n+'+ rounded(spreadBuy/100) +' spread --- '+ recipe.output_item_name +
        ' (buy order for item at '+ rounded(recipePrices.buy/100) +')'+ line);
      renderRecipe(recipe);
      process.stdout.write(line);
    }
  }
};

renderRecipe = function (recipe, level) {
  level = level || 0;
  level && process.stdout.write('\n');
  process.stdout.write('\t'.repeat(level));

  var name = recipe.output_item_name || '???';
  var pricing = prices[recipe.output_item_id];
  var from = '???';
  var each = '???';

  if (pricing && pricing.sell) {
    if (pricing.craft && pricing.craft < pricing.sell) {
      from = 'craft';
      each = rounded(pricing.craft/100);
    } else {
      each = rounded(pricing.sell/100);
    }
  }

  process.stdout.write(name +' x '+ recipe.output_item_count +' ('+ from +' for '+ each +' each)');
  if (recipe.ingredients.length) {
    level++;
    _.forEach(recipe.ingredients, function (ingredient) {
      var ingredientRecipe = false;
      ingredient.recipe_id = ingredientRecipeIds[ingredient.item_id];
      if (ingredient.recipe_id) {
        ingredientRecipe = recipes[ingredient.recipe_id];
      }
      if (!ingredientRecipe) {
        ingredientRecipe = {
          output_item_id: ingredient.item_id,
          output_item_count: ingredient.count,
          output_item_name: names[ingredient.item_id],
          ingredients: []
        };
      }
      renderRecipe(ingredientRecipe, level);
    });
  }
};

getNames()
.then(getPrices)
.then(getRecipes)
.then(function () {
  getRecipeForItem(14886).then(function (recipe) {
    traverseRecipe(recipe).then(showPrices);
  });
  // _.forEach(_.sample(recipes, parseInt(_.size(recipes)/100, 10)), function (recipe) {
  // _.forEach(recipes, function (recipe) {
  //   traverseRecipe(recipe)
  //     .then(showPrices);
  // });
});
